const EXACT_SECRETS = new Set([
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "AZURE_CLIENT_SECRET",
]);

const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|COOKIES?)(?:$|_)/i;

function packagedServerEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (EXACT_SECRETS.has(name) || SECRET_NAME.test(name)) delete env[name];
  }
  // A Finder/Explorer launch may inherit stale development variables. The
  // packaged child is an appliance: it can never register the generic test
  // fleet or disable RealBud's server-owned product gates.
  delete env.OMB_TEST_FLEET;
  env.REALBUD_PACKAGED = "1";
  return env;
}

module.exports = { packagedServerEnvironment };
