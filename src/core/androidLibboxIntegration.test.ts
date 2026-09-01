import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(
  'android/app/src/main/java/io/singdeck/app/SingDeckVpnService.java',
  'utf8'
);

describe('Android libbox integration contract', () => {
  it('resolves a profile ID and hands a validated config and fresh TUN to libbox', () => {
    expect(serviceSource).toContain('profileManager.getProfileContent(profileId)');
    expect(serviceSource).toContain('SingBoxConfigValidator.validate(this, config);');
    expect(serviceSource).toContain('commandServer.startOrReloadService(config, overrideOptions);');
    expect(serviceSource).toContain('tunGeneration <= previousTunGeneration');
    expect(serviceSource).toContain('return newTun.getFd();');
    expect(serviceSource).toContain('Libbox.newStandaloneCommandClient().selectOutbound(group, outbound);');
    expect(serviceSource).not.toContain('EXTRA_CONFIG');
    expect(serviceSource).not.toContain('PREF_CONFIG');
  });

  it('does not contain the previous Java packet forwarding implementation', () => {
    expect(serviceSource).not.toMatch(/DatagramSocket|FileInputStream|handleIncomingIpPacket|forwardDnsQuery/);
    expect(serviceSource).not.toContain('223.5.5.5');
    expect(serviceSource).not.toContain('Math.random');
  });

  it('subscribes to real runtime groups, outbounds, traffic and connections', () => {
    expect(serviceSource).toContain('options.addCommand(Libbox.CommandStatus)');
    expect(serviceSource).toContain('options.addCommand(Libbox.CommandGroup)');
    expect(serviceSource).toContain('options.addCommand(Libbox.CommandConnections)');
    expect(serviceSource).toContain('options.addCommand(Libbox.CommandOutbounds)');
    expect(serviceSource).toContain('connections.applyEvents(events)');
    expect(serviceSource).toContain('client.closeConnection(connectionId)');
    expect(serviceSource).toContain('client.closeConnections()');
    expect(serviceSource).toContain('Libbox.newStandaloneCommandClient().urlTest(outbound)');
  });

  it('pins the official core and packages only arm64 for the requested APK', () => {
    const buildScript = readFileSync('scripts/build-android-libbox.sh', 'utf8');
    const gradle = readFileSync('android/app/build.gradle', 'utf8');

    expect(buildScript).toContain('SING_BOX_VERSION="v1.14.0"');
    expect(buildScript).toContain('SING_BOX_COMMIT="0b8995879f29a9b98ee027bc17b75e101445b238"');
    expect(buildScript).toContain('-target android -platform android/arm64');
    expect(gradle).toContain("abiFilters 'arm64-v8a'");
    expect(gradle).toContain("implementation files('libs/libbox.aar')");
  });
});
