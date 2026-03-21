// Simple in-memory maintenance mode toggle
const MaintenanceService = {
  _enabled: false,

  isEnabled() {
    return this._enabled;
  },

  toggle() {
    this._enabled = !this._enabled;
    return this._enabled;
  },

  setEnabled(val) {
    this._enabled = !!val;
  },
};

module.exports = MaintenanceService;
