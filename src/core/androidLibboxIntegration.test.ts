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
    expect(serviceSource).toContain('commandServer.startOrReloadService(runtimeConfig, overrideOptions);');
    expect(serviceSource).toContain('tunGeneration <= previousTunGeneration');
    expect(serviceSource).toContain('return newTun.getFd();');
    expect(serviceSource).toContain('Libbox.newStandaloneCommandClient().selectOutbound(group, outbound);');
    expect(serviceSource).toContain('只有 Selector 策略组支持手动切换');
    expect(serviceSource).toContain('runtimeGroup.all.contains(outbound)');
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

  it('uses a strict, authenticated local inspector path without leaking hidden runtime tags', () => {
    const buildScript = readFileSync('scripts/build-android-libbox.sh', 'utf8');
    const patch = readFileSync(
      'scripts/patches/sing-box-v1.14.0-libbox-inspector.patch',
      'utf8'
    );
    const overlay = readFileSync(
      'android/app/src/main/java/io/singdeck/app/manager/RuntimeConfigOverlay.java',
      'utf8'
    );

    expect(patch).toContain('UseSocks5(port int32, username string, password string)');
    expect(patch).toContain('return nil, err');
    expect(patch).toContain('SetTimeout(timeoutMillis int64)');
    expect(patch).toContain('ExecuteRaw() (HTTPResponse, error)');
    expect(buildScript).toContain('git -C "$source_dir" apply --check "$inspector_patch"');
    expect(buildScript).toContain('gofmt -d experimental/libbox/http.go');
    expect(overlay).toContain('"listen", "127.0.0.1"');
    expect(overlay).toContain('INSPECTOR_OUTBOUND');
    expect(serviceSource).toContain('RuntimeConfigOverlay.isHiddenTag(group.getTag())');
    expect(serviceSource).toContain('continuing without it');
  });

  it('implements the Proxies Inspector as native Android UI and fail-closed requests', () => {
    const inspectorLayout = readFileSync(
      'android/app/src/main/res/layout/panel_proxies_inspector.xml',
      'utf8'
    );
    const strictClient = readFileSync(
      'android/app/src/main/java/io/singdeck/app/manager/StrictOutboundHttpClient.java',
      'utf8'
    );
    const inspectionEngine = readFileSync(
      'android/app/src/main/java/io/singdeck/app/manager/NativeInspectionEngine.java',
      'utf8'
    );

    expect(inspectorLayout).toContain('@+id/switch_source_restriction');
    expect(inspectorLayout).toContain('@+id/btn_inspector_risk');
    expect(inspectorLayout).toContain('@+id/tv_inspector_result');
    expect(inspectorLayout).not.toContain('<WebView');
    expect(strictClient).toContain('client.useSocks5(');
    expect(strictClient).not.toContain('HttpURLConnection');
    expect(inspectionEngine).toContain('PROBE_LOCK');
    expect(inspectionEngine).toContain('NodeEligibilityPolicy.isAllowed');
  });

  it('runs auto probes only while the VPN runtime is active and persists claims', () => {
    const repository = readFileSync(
      'android/app/src/main/java/io/singdeck/app/manager/InspectorRepository.java',
      'utf8'
    );

    expect(serviceSource).toContain('scheduleWithFixedDelay');
    expect(serviceSource).toContain('stopAutoProbeScheduler');
    expect(serviceSource).toContain('autoProbePaused = true');
    expect(serviceSource).toContain('tryClaimAutoProbe(');
    expect(repository).toContain('CREATE TABLE scheduler_state');
    expect(repository).toContain('SQLiteDatabase.CONFLICT_REPLACE');
  });
});
