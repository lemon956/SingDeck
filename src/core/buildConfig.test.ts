import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('build configuration', () => {
  it('uses relative asset paths so sing-box can serve the UI under /ui/', () => {
    const config = readFileSync('vite.config.ts', 'utf8');

    expect(config).toContain("base: './'");
  });
});
