/** Test-only keyboard boundary for native browser Find on an owned CI display.
 * Browser chrome does not dispatch into the page. If OS input is misdirected,
 * block it before application shortcuts/editing and report the failed handoff.
 * Keep Ctrl/Cmd+F and modifier keys unhandled so native Find can still open.
 * Self-contained so Playwright can serialize this function into a fresh page.
 */
export function installNativeFindInputGuard(targetWindow = window) {
  if (targetWindow.__orcaNativeFindInputGuard) throw new Error('Native Find input guard already installed');
  const state = { blockedKeys: 0, blockedInputs: 0 };
  const onKeyDown = event => {
    if (['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'].includes(event.key)
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f')) return;
    state.blockedKeys += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onBeforeInput = event => {
    state.blockedInputs += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  targetWindow.addEventListener('keydown', onKeyDown, true);
  targetWindow.addEventListener('beforeinput', onBeforeInput, true);
  targetWindow.__orcaNativeFindInputGuard = {
    snapshot: () => ({ ...state }),
    reset: () => { state.blockedKeys = 0; state.blockedInputs = 0; },
    dispose: () => {
      targetWindow.removeEventListener('keydown', onKeyDown, true);
      targetWindow.removeEventListener('beforeinput', onBeforeInput, true);
      delete targetWindow.__orcaNativeFindInputGuard;
    },
  };
}
