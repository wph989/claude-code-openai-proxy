export function createAdminStore() {
  return {
    config: { providers: [], models: [], default_client_model: null, anti_ban: null },
    revision: 0,
    proxyTokenConfigured: false,
    keyStates: {},
    runtimeSettings: { key_auto_disable: true, key_max_errors: 5 },
    activities: [],
    eventConnected: false,

    applyServerView(data, revision = null) {
      this.config = data.config;
      this.revision = revision || data.revision;
      this.proxyTokenConfigured = Boolean(data.proxy_auth_token_configured);
      this.keyStates = data.key_states || {};
      this.runtimeSettings = { ...this.runtimeSettings, ...(data.runtime_settings || {}) };
    },

    setProviderKeys(providerId, keys) {
      this.keyStates[providerId] = keys;
    },

    addActivity(event) {
      if (!event || !Number.isSafeInteger(event.id) || typeof event.type !== 'string') return;
      if (this.activities.some(item => item.id === event.id)) return;
      this.activities.unshift(event);
      if (this.activities.length > 200) this.activities.length = 200;
    },

    clearActivities() {
      this.activities = [];
    },
  };
}
