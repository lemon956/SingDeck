package io.singdeck.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.system.OsConstants;
import android.util.Log;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import io.nekohasekai.libbox.BridgeOptions;
import io.nekohasekai.libbox.BridgeSession;
import io.nekohasekai.libbox.ConnectionOwner;
import io.nekohasekai.libbox.InterfaceUpdateListener;
import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.LocalDNSTransport;
import io.nekohasekai.libbox.NeighborUpdateListener;
import io.nekohasekai.libbox.NetworkInterfaceIterator;
import io.nekohasekai.libbox.Notification;
import io.nekohasekai.libbox.PlatformInterface;
import io.nekohasekai.libbox.PlatformUser;
import io.nekohasekai.libbox.ShellSession;
import io.nekohasekai.libbox.StringIterator;
import io.nekohasekai.libbox.TunOptions;
import io.nekohasekai.libbox.WIFIState;

final class AndroidPlatformInterface implements PlatformInterface, AutoCloseable {
    private static final String TAG = "AndroidPlatform";

    interface VpnHost {
        boolean protectSocket(int fileDescriptor);

        int openTun(TunOptions options) throws Exception;

        void sendCoreNotification(Notification notification) throws Exception;

        void cancelCoreNotification(String identifier, int typeId) throws Exception;
    }

    private final Context context;
    private final VpnHost vpnHost;
    private final ConnectivityManager connectivityManager;
    private final AndroidLocalDnsTransport localDnsTransport;
    private final Object networkMonitorLock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private Network defaultNetwork;
    private InterfaceUpdateListener interfaceUpdateListener;
    private ConnectivityManager.NetworkCallback networkCallback;

    AndroidPlatformInterface(Context context, VpnHost vpnHost) {
        this.context = context.getApplicationContext();
        this.vpnHost = vpnHost;
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.localDnsTransport = new AndroidLocalDnsTransport(this::getDefaultNetwork);
    }

    @Override
    public boolean usePlatformAutoDetectInterfaceControl() {
        return true;
    }

    @Override
    public void autoDetectInterfaceControl(int fileDescriptor) throws Exception {
        if (!vpnHost.protectSocket(fileDescriptor)) {
            throw new Exception("Android VpnService failed to protect socket fd " + fileDescriptor);
        }
    }

    @Override
    public int openTun(TunOptions options) throws Exception {
        return vpnHost.openTun(options);
    }

    @Override
    public boolean useProcFS() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q;
    }

    @Override
    public ConnectionOwner findConnectionOwner(
            int ipProtocol,
            String sourceAddress,
            int sourcePort,
            String destinationAddress,
            int destinationPort
    ) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new Exception("Android connection owner lookup requires API 29 or newer");
        }
        int uid = connectivityManager.getConnectionOwnerUid(
                ipProtocol,
                new InetSocketAddress(sourceAddress, sourcePort),
                new InetSocketAddress(destinationAddress, destinationPort)
        );
        if (uid == Process.INVALID_UID) {
            throw new Exception("Android connection owner was not found");
        }

        String[] packages = context.getPackageManager().getPackagesForUid(uid);
        ConnectionOwner owner = new ConnectionOwner();
        owner.setUserId(uid);
        owner.setUserName(packages != null && packages.length > 0 ? packages[0] : "");
        List<String> packageNames = new ArrayList<>();
        if (packages != null) {
            Collections.addAll(packageNames, packages);
        }
        owner.setAndroidPackageNames(LibboxIterators.strings(packageNames));
        return owner;
    }

    @Override
    public void startDefaultInterfaceMonitor(InterfaceUpdateListener listener) throws Exception {
        if (connectivityManager == null) {
            throw new Exception("Android ConnectivityManager is unavailable");
        }

        synchronized (networkMonitorLock) {
            unregisterNetworkCallbackLocked();
            interfaceUpdateListener = listener;
            NetworkRequest request = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                    .build();
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    publishDefaultNetwork(network);
                }

                @Override
                public void onLinkPropertiesChanged(Network network, LinkProperties linkProperties) {
                    synchronized (networkMonitorLock) {
                        if (network.equals(defaultNetwork)) {
                            publishDefaultNetworkLocked(network, linkProperties);
                        }
                    }
                }

                @Override
                public void onLost(Network network) {
                    synchronized (networkMonitorLock) {
                        if (!network.equals(defaultNetwork)) {
                            return;
                        }
                        defaultNetwork = null;
                        if (interfaceUpdateListener != null) {
                            interfaceUpdateListener.updateDefaultInterface("", -1, false, false);
                        }
                    }
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                connectivityManager.registerBestMatchingNetworkCallback(request, networkCallback, mainHandler);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                connectivityManager.requestNetwork(request, networkCallback, mainHandler);
            } else {
                connectivityManager.requestNetwork(request, networkCallback);
            }
        }
    }

    @Override
    public void closeDefaultInterfaceMonitor(InterfaceUpdateListener listener) {
        synchronized (networkMonitorLock) {
            if (interfaceUpdateListener != null && listener != null && interfaceUpdateListener != listener) {
                return;
            }
            unregisterNetworkCallbackLocked();
            interfaceUpdateListener = null;
            defaultNetwork = null;
        }
    }

    @Override
    public NetworkInterfaceIterator getInterfaces() throws Exception {
        if (connectivityManager == null) {
            throw new Exception("Android ConnectivityManager is unavailable");
        }

        Map<String, io.nekohasekai.libbox.NetworkInterface> interfaces = new LinkedHashMap<>();
        for (Network network : connectivityManager.getAllNetworks()) {
            LinkProperties linkProperties = connectivityManager.getLinkProperties(network);
            NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
            if (linkProperties == null || capabilities == null || linkProperties.getInterfaceName() == null) {
                continue;
            }
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                continue;
            }

            String name = linkProperties.getInterfaceName();
            java.net.NetworkInterface javaInterface = java.net.NetworkInterface.getByName(name);
            if (javaInterface == null) {
                continue;
            }

            io.nekohasekai.libbox.NetworkInterface boxInterface = new io.nekohasekai.libbox.NetworkInterface();
            boxInterface.setName(name);
            boxInterface.setIndex(javaInterface.getIndex());
            try {
                boxInterface.setMTU(javaInterface.getMTU());
            } catch (Exception exception) {
                Log.w(TAG, "Unable to read MTU for " + name, exception);
            }
            boxInterface.setType(interfaceType(capabilities));
            boxInterface.setMetered(!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            boxInterface.setFlags(interfaceFlags(javaInterface, capabilities));
            boxInterface.setAddresses(LibboxIterators.strings(interfaceAddresses(javaInterface)));
            boxInterface.setDNSServer(LibboxIterators.strings(dnsServers(linkProperties)));
            boxInterface.setGateway(LibboxIterators.strings(defaultGateways(linkProperties)));
            interfaces.put(name, boxInterface);
        }
        return LibboxIterators.interfaces(new ArrayList<>(interfaces.values()));
    }

    @Override
    public boolean underNetworkExtension() {
        return false;
    }

    @Override
    public boolean includeAllNetworks() {
        return false;
    }

    @Override
    public void clearDNSCache() {
        // Android does not expose a public DNS cache flush API.
    }

    @Override
    public WIFIState readWIFIState() {
        try {
            WifiManager manager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (manager == null) {
                return null;
            }
            @SuppressWarnings("deprecation")
            WifiInfo info = manager.getConnectionInfo();
            if (info == null) {
                return null;
            }
            String ssid = info.getSSID();
            if (ssid == null || WifiManager.UNKNOWN_SSID.equals(ssid)) {
                return new WIFIState("", "");
            }
            if (ssid.length() >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) {
                ssid = ssid.substring(1, ssid.length() - 1);
            }
            return new WIFIState(ssid, info.getBSSID() == null ? "" : info.getBSSID());
        } catch (SecurityException exception) {
            Log.w(TAG, "Wi-Fi state permission is unavailable", exception);
            return null;
        }
    }

    @Override
    public LocalDNSTransport localDNSTransport() {
        return localDnsTransport;
    }

    @Override
    public boolean usePlatformShell() {
        return false;
    }

    @Override
    public void checkPlatformShell() throws Exception {
        throw unsupported("platform shell");
    }

    @Override
    public ShellSession openShellSession(
            PlatformUser user,
            String command,
            StringIterator environment,
            String terminal,
            int rows,
            int columns
    ) throws Exception {
        throw unsupported("platform shell");
    }

    @Override
    public String readSystemSSHHostKey() throws Exception {
        throw unsupported("system SSH host key");
    }

    @Override
    public String lookupSFTPServer() throws Exception {
        throw unsupported("SFTP server");
    }

    @Override
    public String tailscaleHostname() {
        return Build.MANUFACTURER + " " + Build.MODEL;
    }

    @Override
    public boolean usePlatformBridge() {
        return false;
    }

    @Override
    public BridgeSession createBridge(BridgeOptions options) throws Exception {
        throw unsupported("platform bridge");
    }

    @Override
    public PlatformUser lookupUser(String username) throws Exception {
        String packageName = username == null || username.trim().isEmpty()
                ? context.getPackageName()
                : username;
        ApplicationInfo applicationInfo = context.getPackageManager().getApplicationInfo(packageName, 0);
        PlatformUser user = new PlatformUser();
        user.setUsername(packageName);
        user.setUid(applicationInfo.uid);
        user.setGid(applicationInfo.uid);
        user.setHomeDir(context.getFilesDir().getAbsolutePath());
        user.setShell("");
        return user;
    }

    @Override
    public void registerMyInterface(String name) {
        // The Android VPN interface is owned by VpnService and needs no extra registration.
    }

    @Override
    public void startNeighborMonitor(NeighborUpdateListener listener) {
        // Neighbor-table monitoring requires privileged Android APIs and is optional.
    }

    @Override
    public void closeNeighborMonitor(NeighborUpdateListener listener) {
        // No neighbor monitor is registered by this non-root implementation.
    }

    @Override
    public void sendNotification(Notification notification) throws Exception {
        vpnHost.sendCoreNotification(notification);
    }

    @Override
    public void cancelNotification(String identifier, int typeId) throws Exception {
        vpnHost.cancelCoreNotification(identifier, typeId);
    }

    private Network getDefaultNetwork() {
        synchronized (networkMonitorLock) {
            if (defaultNetwork != null) {
                return defaultNetwork;
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && connectivityManager != null) {
            Network activeNetwork = connectivityManager.getActiveNetwork();
            NetworkCapabilities capabilities = activeNetwork == null
                    ? null
                    : connectivityManager.getNetworkCapabilities(activeNetwork);
            if (capabilities != null && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                return activeNetwork;
            }
        }
        if (connectivityManager != null) {
            for (Network network : connectivityManager.getAllNetworks()) {
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
                if (capabilities != null
                        && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return network;
                }
            }
        }
        return null;
    }

    private void publishDefaultNetwork(Network network) {
        LinkProperties linkProperties = connectivityManager.getLinkProperties(network);
        synchronized (networkMonitorLock) {
            publishDefaultNetworkLocked(network, linkProperties);
        }
    }

    private void publishDefaultNetworkLocked(Network network, LinkProperties linkProperties) {
        defaultNetwork = network;
        if (interfaceUpdateListener == null || linkProperties == null || linkProperties.getInterfaceName() == null) {
            return;
        }
        int interfaceIndex = -1;
        try {
            java.net.NetworkInterface javaInterface = java.net.NetworkInterface.getByName(linkProperties.getInterfaceName());
            if (javaInterface != null) {
                interfaceIndex = javaInterface.getIndex();
            }
        } catch (Exception exception) {
            Log.w(TAG, "Unable to resolve default interface index", exception);
        }
        interfaceUpdateListener.updateDefaultInterface(
                linkProperties.getInterfaceName(),
                interfaceIndex,
                false,
                false
        );
    }

    private void unregisterNetworkCallbackLocked() {
        if (networkCallback == null || connectivityManager == null) {
            networkCallback = null;
            return;
        }
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException exception) {
            Log.w(TAG, "Unable to unregister default network callback", exception);
        }
        networkCallback = null;
    }

    private static int interfaceType(NetworkCapabilities capabilities) {
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return Libbox.InterfaceTypeWIFI;
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            return Libbox.InterfaceTypeCellular;
        }
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
            return Libbox.InterfaceTypeEthernet;
        }
        return Libbox.InterfaceTypeOther;
    }

    private static int interfaceFlags(
            java.net.NetworkInterface networkInterface,
            NetworkCapabilities capabilities
    ) throws Exception {
        int flags = 0;
        if (networkInterface.isUp()
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            flags |= OsConstants.IFF_UP | OsConstants.IFF_RUNNING;
        }
        if (networkInterface.isLoopback()) {
            flags |= OsConstants.IFF_LOOPBACK;
        }
        if (networkInterface.isPointToPoint()) {
            flags |= OsConstants.IFF_POINTOPOINT;
        }
        if (networkInterface.supportsMulticast()) {
            flags |= OsConstants.IFF_MULTICAST;
        }
        return flags;
    }

    private static List<String> interfaceAddresses(java.net.NetworkInterface networkInterface) {
        List<String> addresses = new ArrayList<>();
        for (InterfaceAddress interfaceAddress : networkInterface.getInterfaceAddresses()) {
            InetAddress address = interfaceAddress.getAddress();
            if (address == null || address.getHostAddress() == null) {
                continue;
            }
            String hostAddress = address.getHostAddress();
            if (address instanceof Inet6Address) {
                int zoneIndex = hostAddress.indexOf('%');
                if (zoneIndex >= 0) {
                    hostAddress = hostAddress.substring(0, zoneIndex);
                }
            }
            addresses.add(hostAddress + "/" + interfaceAddress.getNetworkPrefixLength());
        }
        return addresses;
    }

    private static List<String> dnsServers(LinkProperties linkProperties) {
        List<String> servers = new ArrayList<>();
        for (InetAddress address : linkProperties.getDnsServers()) {
            if (address.getHostAddress() != null) {
                servers.add(address.getHostAddress());
            }
        }
        return servers;
    }

    private static List<String> defaultGateways(LinkProperties linkProperties) {
        List<String> gateways = new ArrayList<>();
        for (android.net.RouteInfo route : linkProperties.getRoutes()) {
            if (route.getDestination() == null || route.getDestination().getPrefixLength() != 0) {
                continue;
            }
            InetAddress gateway = route.getGateway();
            if (gateway != null && !gateway.isAnyLocalAddress() && gateway.getHostAddress() != null) {
                gateways.add(gateway.getHostAddress());
            }
        }
        return gateways;
    }

    private static Exception unsupported(String capability) {
        return new Exception("Android " + capability + " is not supported by SingDeck");
    }

    @Override
    public void close() {
        synchronized (networkMonitorLock) {
            unregisterNetworkCallbackLocked();
            interfaceUpdateListener = null;
            defaultNetwork = null;
        }
        localDnsTransport.close();
    }
}
