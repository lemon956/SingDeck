import { describe, expect, it } from 'vitest';
import { buildSingBoxRemoteProfileUri } from './helperApi';

describe('helper remote profile QR', () => {
  it('wraps a config download URL in the sing-box remote profile URI scheme', () => {
    expect(buildSingBoxRemoteProfileUri('http://192.168.1.20:9531/api/v1/config/raw', 'SingDeck')).toBe(
      'sing-box://import-remote-profile?url=http%3A%2F%2F192.168.1.20%3A9531%2Fapi%2Fv1%2Fconfig%2Fraw#SingDeck'
    );
  });
});
