import { dirname, join } from 'node:path';

// The smoke must not inherit a developer's provider keys, connector settings,
// module search path or real Windows application-data directories. Electron's
// Node mode must survive into the child or an installed app launches a GUI.
export function serviceSmokeEnv({ executable, home, data, scratch, port }, source = process.env) {
  const env = {
    PATH: dirname(executable), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: scratch, TEMP: scratch, TMPDIR: scratch,
    REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'), HERMES_HOME: join(data, 'hermes'),
    REALBUD_MANAGED_SERVICE: '1', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '1',
    ELECTRON_RUN_AS_NODE: '1', OMB_PORT: String(port), LANG: 'C', LC_ALL: 'C',
  };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) {
    if (source[key]) env[key] = source[key];
  }
  // Windows file privacy runs through powershell.exe with the .NET access-control
  // API, so no module load is needed; the pin still keeps a stripped environment
  // from borrowing a developer's or PowerShell 7 module path.
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR;
  if (systemRoot) env.PSModulePath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}
