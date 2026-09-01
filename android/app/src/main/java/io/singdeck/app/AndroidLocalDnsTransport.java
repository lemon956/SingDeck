package io.singdeck.app;

import android.net.DnsResolver;
import android.net.Network;
import android.os.Build;
import android.os.CancellationSignal;
import android.system.ErrnoException;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import io.nekohasekai.libbox.ExchangeContext;
import io.nekohasekai.libbox.LocalDNSTransport;

final class AndroidLocalDnsTransport implements LocalDNSTransport, AutoCloseable {
    private static final int RCODE_NXDOMAIN = 3;
    private static final long DNS_TIMEOUT_SECONDS = 30;

    interface NetworkProvider {
        Network getDefaultNetwork();
    }

    private final NetworkProvider networkProvider;
    private final ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "SingDeck-LocalDNS");
        thread.setDaemon(true);
        return thread;
    });

    AndroidLocalDnsTransport(NetworkProvider networkProvider) {
        this.networkProvider = networkProvider;
    }

    @Override
    public boolean raw() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
    }

    @Override
    public void exchange(ExchangeContext context, byte[] message) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new Exception("Android raw DNS requires API 29 or newer");
        }

        Network network = requireDefaultNetwork();
        CancellationSignal signal = new CancellationSignal();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Exception> failure = new AtomicReference<>();
        context.onCancel(() -> {
            signal.cancel();
            done.countDown();
        });

        DnsResolver.getInstance().rawQuery(
                network,
                message,
                DnsResolver.FLAG_NO_RETRY,
                executor,
                signal,
                new DnsResolver.Callback<byte[]>() {
                    @Override
                    public void onAnswer(byte[] answer, int rcode) {
                        try {
                            if (rcode == 0) {
                                context.rawSuccess(answer);
                            } else {
                                context.errorCode(rcode);
                            }
                        } catch (Exception exception) {
                            failure.set(exception);
                        } finally {
                            done.countDown();
                        }
                    }

                    @Override
                    public void onError(DnsResolver.DnsException error) {
                        handleDnsError(context, error, failure);
                        done.countDown();
                    }
                }
        );

        awaitResult(done, failure);
    }

    @Override
    public void lookup(ExchangeContext context, String networkName, String domain) throws Exception {
        Network network = requireDefaultNetwork();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            lookupLegacy(context, network, domain);
            return;
        }

        CancellationSignal signal = new CancellationSignal();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Exception> failure = new AtomicReference<>();
        context.onCancel(() -> {
            signal.cancel();
            done.countDown();
        });

        DnsResolver.Callback<List<InetAddress>> callback = new DnsResolver.Callback<List<InetAddress>>() {
            @Override
            public void onAnswer(List<InetAddress> answer, int rcode) {
                try {
                    if (rcode == 0) {
                        context.success(joinAddresses(answer));
                    } else {
                        context.errorCode(rcode);
                    }
                } catch (Exception exception) {
                    failure.set(exception);
                } finally {
                    done.countDown();
                }
            }

            @Override
            public void onError(DnsResolver.DnsException error) {
                handleDnsError(context, error, failure);
                done.countDown();
            }
        };

        Integer queryType = null;
        if (networkName != null && networkName.endsWith("4")) {
            queryType = DnsResolver.TYPE_A;
        } else if (networkName != null && networkName.endsWith("6")) {
            queryType = DnsResolver.TYPE_AAAA;
        }

        if (queryType == null) {
            DnsResolver.getInstance().query(
                    network,
                    domain,
                    DnsResolver.FLAG_NO_RETRY,
                    executor,
                    signal,
                    callback
            );
        } else {
            DnsResolver.getInstance().query(
                    network,
                    domain,
                    queryType,
                    DnsResolver.FLAG_NO_RETRY,
                    executor,
                    signal,
                    callback
            );
        }

        awaitResult(done, failure);
    }

    private Network requireDefaultNetwork() throws Exception {
        Network network = networkProvider.getDefaultNetwork();
        if (network == null) {
            throw new Exception("Android default network is unavailable");
        }
        return network;
    }

    private static void lookupLegacy(ExchangeContext context, Network network, String domain) throws Exception {
        try {
            context.success(joinAddresses(network.getAllByName(domain)));
        } catch (UnknownHostException exception) {
            context.errorCode(RCODE_NXDOMAIN);
        }
    }

    private static void handleDnsError(
            ExchangeContext context,
            DnsResolver.DnsException error,
            AtomicReference<Exception> failure
    ) {
        Throwable cause = error.getCause();
        try {
            if (cause instanceof ErrnoException) {
                context.errnoCode(((ErrnoException) cause).errno);
            } else {
                failure.set(error);
            }
        } catch (Exception exception) {
            failure.set(exception);
        }
    }

    private static void awaitResult(CountDownLatch done, AtomicReference<Exception> failure) throws Exception {
        if (!done.await(DNS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw new Exception("Android DNS query timed out");
        }
        Exception exception = failure.get();
        if (exception != null) {
            throw exception;
        }
    }

    private static String joinAddresses(InetAddress[] addresses) {
        StringBuilder result = new StringBuilder();
        for (InetAddress address : addresses) {
            appendAddress(result, address);
        }
        return result.toString();
    }

    private static String joinAddresses(List<InetAddress> addresses) {
        StringBuilder result = new StringBuilder();
        for (InetAddress address : addresses) {
            appendAddress(result, address);
        }
        return result.toString();
    }

    private static void appendAddress(StringBuilder result, InetAddress address) {
        if (address == null || address.getHostAddress() == null) {
            return;
        }
        if (result.length() > 0) {
            result.append('\n');
        }
        result.append(address.getHostAddress());
    }

    @Override
    public void close() {
        executor.shutdownNow();
    }
}
