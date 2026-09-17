import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hermesHome, runtimeCli } from './hermes-paths.ts';
afterEach(() => vi.unstubAllEnvs());
function clear() { for (const name of ['REALBUD_HERMES_HOME','REALBUD_DATA_DIR','OMB_DATA_DIR','HERMES_HOME','REALBUD_USE_SHARED_HERMES']) vi.stubEnv(name, ''); }
it('uses a private RealBud profile when launched without shell configuration', () => {
  clear(); expect(hermesHome()).toBe(join(homedir(), '.realbud', 'hermes'));
  expect(hermesHome()).not.toBe(join(homedir(), '.hermes'));
});
it('keeps explicitly separate desktop data roots isolated from ambient personal Hermes', () => {
  clear(); vi.stubEnv('HERMES_HOME', '/personal/hermes'); vi.stubEnv('REALBUD_DATA_DIR', '/desktop-a');
  expect(hermesHome()).toBe(join('/desktop-a', 'hermes'));
  vi.stubEnv('REALBUD_DATA_DIR', '/desktop-b'); expect(hermesHome()).toBe(join('/desktop-b', 'hermes'));
  vi.stubEnv('REALBUD_HERMES_HOME', '/explicit/owned'); expect(hermesHome()).toBe('/explicit/owned');
});
it('selects the Windows executable layout without depending on a Unix shell', () => {
  expect(runtimeCli('/fixture', 'win32')).toBe(join('/fixture', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'));
  expect(runtimeCli('/fixture', 'darwin')).toBe(join('/fixture', 'hermes-agent', 'venv', 'bin', 'hermes'));
});
it('resolves an isolated child home without reading the parent process settings', () => {
  vi.stubEnv('REALBUD_HERMES_HOME', '/parent-worker');
  expect(hermesHome(undefined, { HOME: '/child', USERPROFILE: '/child' })).toBe(join('/child', '.realbud', 'hermes'));
  expect(hermesHome(undefined, { REALBUD_DATA_DIR: '/child-data', HERMES_HOME: '/parent-personal' })).toBe(join('/child-data', 'hermes'));
});
