package io.singdeck.app.manager;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SingBoxConfigValidatorTest {
    private static final String VALID_TUN = "{"
            + "\"inbounds\":[{\"type\":\"tun\",\"address\":[\"172.19.0.1/30\"],"
            + "\"auto_route\":true}],\"outbounds\":[]}";

    @Test
    public void acceptsOneRoutedAndroidTun() throws Exception {
        SingBoxConfigValidator.validateAndroidVpnShape(VALID_TUN);
    }

    @Test
    public void rejectsMissingOrMultipleTunInbounds() {
        SingBoxConfigValidator.ValidationException missing = assertThrows(
                SingBoxConfigValidator.ValidationException.class,
                () -> SingBoxConfigValidator.validateAndroidVpnShape("{\"inbounds\":[]}")
        );
        assertTrue(missing.getMessage().contains("当前 0 个"));

        SingBoxConfigValidator.ValidationException multiple = assertThrows(
                SingBoxConfigValidator.ValidationException.class,
                () -> SingBoxConfigValidator.validateAndroidVpnShape("{\"inbounds\":["
                        + "{\"type\":\"tun\",\"address\":\"172.19.0.1/30\",\"auto_route\":true},"
                        + "{\"type\":\"tun\",\"address\":\"fdfe:dcba:9876::1/126\","
                        + "\"auto_route\":true}]}")
        );
        assertTrue(multiple.getMessage().contains("当前 2 个"));
    }

    @Test
    public void rejectsTunThatCannotCaptureAndroidTraffic() {
        SingBoxConfigValidator.ValidationException noAddress = assertThrows(
                SingBoxConfigValidator.ValidationException.class,
                () -> SingBoxConfigValidator.validateAndroidVpnShape(
                        "{\"inbounds\":[{\"type\":\"tun\",\"auto_route\":true}]}"
                )
        );
        assertTrue(noAddress.getMessage().contains("address"));

        SingBoxConfigValidator.ValidationException noAutoRoute = assertThrows(
                SingBoxConfigValidator.ValidationException.class,
                () -> SingBoxConfigValidator.validateAndroidVpnShape(
                        "{\"inbounds\":[{\"type\":\"tun\","
                                + "\"address\":\"172.19.0.1/30\",\"auto_route\":false}]}"
                )
        );
        assertTrue(noAutoRoute.getMessage().contains("auto_route"));
    }
}
