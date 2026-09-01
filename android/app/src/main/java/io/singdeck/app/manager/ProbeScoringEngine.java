package io.singdeck.app.manager;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

import io.singdeck.app.model.MobileBootstrap;

/** Native port of the Helper's connectivity score algorithm. */
public final class ProbeScoringEngine {
    public static final int MAX_SAMPLE_COUNT = 10;
    private static final long MIN_SAMPLE_WINDOW_MS = 30 * 60 * 1_000L;
    private static final int SAMPLE_WINDOW_INTERVAL_MULTIPLIER = 6;
    private static final double CONFIDENCE_SAMPLE_TARGET = 5.0;

    private ProbeScoringEngine() {
    }

    public static final class ProbeSample {
        public final Integer delayMs;
        public final boolean success;
        public final String error;
        public final long testedAt;

        public ProbeSample(Integer delayMs, boolean success, String error, long testedAt) {
            this.delayMs = delayMs;
            this.success = success;
            this.error = error;
            this.testedAt = testedAt;
        }
    }

    public static final class Components {
        public final double latency;
        public final double availability;
        public final double jitter;
        public final double freshness;

        Components(double latency, double availability, double jitter, double freshness) {
            this.latency = round(latency);
            this.availability = round(availability);
            this.jitter = round(jitter);
            this.freshness = round(freshness);
        }
    }

    public static final class NodeScore {
        public final String node;
        public final double score;
        public final Integer delayMs;
        public final Components components;
        public final boolean success;
        public final String error;
        public final long testedAt;
        public final int sampleCount;
        public final int successCount;
        public final String freshnessState;
        public final String gateReason;

        NodeScore(
                String node,
                double score,
                Integer delayMs,
                Components components,
                boolean success,
                String error,
                long testedAt,
                int sampleCount,
                int successCount,
                String freshnessState,
                String gateReason
        ) {
            this.node = node;
            this.score = round(score);
            this.delayMs = delayMs;
            this.components = components;
            this.success = success;
            this.error = error;
            this.testedAt = testedAt;
            this.sampleCount = sampleCount;
            this.successCount = successCount;
            this.freshnessState = freshnessState;
            this.gateReason = gateReason;
        }
    }

    public static NodeScore score(
            String node,
            List<ProbeSample> input,
            MobileBootstrap.GroupSettings settings,
            long now
    ) {
        List<ProbeSample> samples = normalizedSamples(input, settings, now);
        ProbeSample latest = samples.isEmpty() ? null : samples.get(samples.size() - 1);
        int successCount = 0;
        for (ProbeSample sample : samples) {
            if (sample.success) {
                successCount++;
            }
        }
        String freshness = latest == null ? null : freshnessState(now - latest.testedAt, settings);
        String gate = latest == null
                ? "no_sample"
                : !latest.success ? "latest_failed" : "expired".equals(freshness) ? "expired" : "none";
        if (!"none".equals(gate)) {
            return zero(node, latest, samples.size(), successCount, freshness, gate);
        }

        Components components = new Components(
                latencyScore(samples),
                availabilityScore(samples),
                jitterScore(samples),
                "fresh".equals(freshness) ? 100.0 : "stale".equals(freshness) ? 80.0 : 0.0
        );
        double value;
        if (settings != null && "delay".equalsIgnoreCase(settings.mode)) {
            value = components.latency;
        } else if (settings != null && "LatencyFirst".equalsIgnoreCase(settings.scheme)) {
            value = components.latency * 0.45
                    + components.availability * 0.45
                    + components.jitter * 0.10;
        } else {
            value = components.latency * 0.30
                    + components.availability * 0.60
                    + components.jitter * 0.10;
        }
        if ("stale".equals(freshness)) {
            value = Math.min(value, 80.0);
        }
        return new NodeScore(
                node,
                value,
                latest.delayMs,
                components,
                true,
                latest.error,
                latest.testedAt,
                samples.size(),
                successCount,
                freshness,
                gate
        );
    }

    public static Comparator<NodeScore> comparator(MobileBootstrap.GroupSettings settings) {
        if (settings != null && "delay".equalsIgnoreCase(settings.mode)) {
            return ProbeScoringEngine::compareDelayThenName;
        }
        return (left, right) -> {
            int score = Double.compare(right.score, left.score);
            return score != 0 ? score : compareDelayThenName(left, right);
        };
    }

    public static long sampleWindowMs(MobileBootstrap.GroupSettings settings) {
        long interval = settings == null ? 900 : settings.probeIntervalSec;
        interval = Math.max(60, Math.min(24 * 60 * 60, interval));
        return Math.max(MIN_SAMPLE_WINDOW_MS, interval * SAMPLE_WINDOW_INTERVAL_MULTIPLIER * 1_000L);
    }

    private static NodeScore zero(
            String node,
            ProbeSample latest,
            int sampleCount,
            int successCount,
            String freshness,
            String gate
    ) {
        return new NodeScore(
                node,
                0.0,
                null,
                new Components(0, 0, 0, 0),
                false,
                latest == null ? null : latest.error,
                latest == null ? 0 : latest.testedAt,
                sampleCount,
                successCount,
                freshness,
                gate
        );
    }

    private static List<ProbeSample> normalizedSamples(
            List<ProbeSample> input,
            MobileBootstrap.GroupSettings settings,
            long now
    ) {
        long start = now - sampleWindowMs(settings);
        List<ProbeSample> samples = new ArrayList<>();
        if (input != null) {
            for (ProbeSample sample : input) {
                if (sample != null && sample.testedAt >= start) {
                    samples.add(sample);
                }
            }
        }
        samples.sort(Comparator.comparingLong(value -> value.testedAt));
        if (samples.size() > MAX_SAMPLE_COUNT) {
            return new ArrayList<>(samples.subList(samples.size() - MAX_SAMPLE_COUNT, samples.size()));
        }
        return samples;
    }

    private static double latencyScore(List<ProbeSample> samples) {
        List<Integer> delays = successfulDelays(samples);
        if (delays.isEmpty()) {
            return 0;
        }
        return curve(percentile(delays, 0.50)) * 0.70 + curve(percentile(delays, 0.90)) * 0.30;
    }

    private static double availabilityScore(List<ProbeSample> samples) {
        if (samples.isEmpty()) {
            return 0;
        }
        int successes = successfulDelays(samples).size();
        double confidence = Math.min(samples.size() / CONFIDENCE_SAMPLE_TARGET, 1.0);
        return successes / (double) samples.size() * confidence * 100.0;
    }

    private static double jitterScore(List<ProbeSample> samples) {
        List<Integer> delays = successfulDelays(samples);
        if (delays.size() < 2) {
            return delays.isEmpty() ? 0.0 : 50.0;
        }
        double jitter = Math.max(0, percentile(delays, 0.90) - percentile(delays, 0.50));
        if (jitter <= 80) {
            return 100.0;
        }
        if (jitter <= 500) {
            return linear(jitter, 80, 500, 100, 0);
        }
        return 0.0;
    }

    private static List<Integer> successfulDelays(List<ProbeSample> samples) {
        List<Integer> delays = new ArrayList<>();
        for (ProbeSample sample : samples) {
            if (sample.success && sample.delayMs != null) {
                delays.add(sample.delayMs);
            }
        }
        delays.sort(Integer::compareTo);
        return delays;
    }

    private static int percentile(List<Integer> values, double percentile) {
        int index = (int) Math.round((values.size() - 1) * Math.max(0, Math.min(1, percentile)));
        return values.get(Math.min(index, values.size() - 1));
    }

    private static double curve(int delay) {
        if (delay <= 120) {
            return 100;
        }
        if (delay <= 400) {
            return linear(delay, 120, 400, 100, 75);
        }
        if (delay <= 1_000) {
            return linear(delay, 400, 1_000, 75, 35);
        }
        if (delay <= 2_500) {
            return linear(delay, 1_000, 2_500, 35, 5);
        }
        return 0;
    }

    private static double linear(double value, double from, double to, double fromScore, double toScore) {
        double ratio = Math.max(0, Math.min(1, (value - from) / (to - from)));
        return fromScore + (toScore - fromScore) * ratio;
    }

    private static String freshnessState(long ageMs, MobileBootstrap.GroupSettings settings) {
        long fresh = Math.max(120_000L,
                Math.max(60, settings == null ? 900 : settings.probeIntervalSec) * 1_000L);
        if (ageMs <= fresh) {
            return "fresh";
        }
        return ageMs <= fresh * 3 ? "stale" : "expired";
    }

    private static int compareDelayThenName(NodeScore left, NodeScore right) {
        if (left.delayMs != null && right.delayMs != null) {
            int delay = Integer.compare(left.delayMs, right.delayMs);
            return delay != 0 ? delay : left.node.compareTo(right.node);
        }
        if (left.delayMs != null) {
            return -1;
        }
        if (right.delayMs != null) {
            return 1;
        }
        return left.node.compareTo(right.node);
    }

    private static double round(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
