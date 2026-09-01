package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import io.singdeck.app.model.MobileBootstrap;

public class ProbeScoringEngineTest {
    @Test
    public void balancedScoreMatchesHelperConfidenceFormula() {
        long now = 1_000_000L;
        MobileBootstrap.GroupSettings settings = settings();
        ProbeScoringEngine.NodeScore score = ProbeScoringEngine.score(
                "hk",
                List.of(new ProbeScoringEngine.ProbeSample(100, true, null, now)),
                settings,
                now
        );

        assertEquals(47.0, score.score, 0.001);
        assertEquals(100.0, score.components.latency, 0.001);
        assertEquals(20.0, score.components.availability, 0.001);
        assertEquals(50.0, score.components.jitter, 0.001);
    }

    @Test
    public void latestFailureAndExpiredSampleAreHardGates() {
        long now = 10_000_000L;
        MobileBootstrap.GroupSettings settings = settings();
        List<ProbeScoringEngine.ProbeSample> failed = List.of(
                new ProbeScoringEngine.ProbeSample(80, true, null, now - 1_000),
                new ProbeScoringEngine.ProbeSample(null, false, "timeout", now)
        );
        assertEquals("latest_failed",
                ProbeScoringEngine.score("hk", failed, settings, now).gateReason);
        assertEquals(0.0, ProbeScoringEngine.score("hk", failed, settings, now).score, 0.001);

        ProbeScoringEngine.NodeScore expired = ProbeScoringEngine.score(
                "hk",
                List.of(new ProbeScoringEngine.ProbeSample(80, true, null, now - 500_000)),
                settings,
                now
        );
        assertEquals("expired", expired.gateReason);
        assertEquals(0.0, expired.score, 0.001);
    }

    @Test
    public void keepsOnlyLatestTenSamplesAndSortsByScore() {
        long now = 20_000_000L;
        MobileBootstrap.GroupSettings settings = settings();
        List<ProbeScoringEngine.ProbeSample> samples = new ArrayList<>();
        for (int index = 0; index < 12; index++) {
            samples.add(new ProbeScoringEngine.ProbeSample(100 + index, true, null, now - 12 + index));
        }
        ProbeScoringEngine.NodeScore score = ProbeScoringEngine.score("hk", samples, settings, now);
        assertEquals(10, score.sampleCount);
        assertEquals(10, score.successCount);
        assertTrue(score.score > 95);
    }

    private static MobileBootstrap.GroupSettings settings() {
        MobileBootstrap.GroupSettings settings = new MobileBootstrap.GroupSettings();
        settings.mode = "score";
        settings.scheme = "Balanced";
        settings.probeIntervalSec = 60;
        return settings;
    }
}
