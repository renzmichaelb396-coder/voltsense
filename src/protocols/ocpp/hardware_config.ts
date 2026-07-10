// OCPP local hardware & WebSocket environment config — pilot bench toggle
// No 'any'. Discriminated union on testState.status for mock vs physical BESEN.

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_OCPP_WS_PORT = 8080 as const;

const MIN_PORT = 1 as const;
const MAX_PORT = 65535 as const;

// ─── Hardware test state — discriminated on status ───────────────────────────

export type HardwareTestState =
  | {
      readonly status: 'mock_harness';
      readonly simulatedChargerId: string;
    }
  | {
      readonly status: 'physical_hardware';
      readonly activeChargerId: string;
      readonly firmwareVersion: string;
    };

// ─── Resolved config shape ───────────────────────────────────────────────────

export type OcppHardwareConfig = {
  readonly wsPort: number;
  readonly testState: HardwareTestState;
};

// ─── Type guards ─────────────────────────────────────────────────────────────

export function isMockHarnessState(
  state: HardwareTestState,
): state is Extract<HardwareTestState, { status: 'mock_harness' }> {
  return state.status === 'mock_harness';
}

export function isPhysicalHardwareState(
  state: HardwareTestState,
): state is Extract<HardwareTestState, { status: 'physical_hardware' }> {
  return state.status === 'physical_hardware';
}

// ─── Environment port loader ─────────────────────────────────────────────────

export function loadOcppWsPortFromEnv(
  raw: string | undefined = process.env['VOLTSENSE_OCPP_WS_PORT'],
): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_OCPP_WS_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `[OCPP CONFIG] VOLTSENSE_OCPP_WS_PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}, got "${raw}"`,
    );
  }

  return parsed;
}

// ─── Physical-hardware port lock (Law §10.1 — routing invariant) ─────────────
// A live BESEN station MUST bind the canonical isolated port 8080. Relocating the
// port while in physical_hardware mode is refused at boot, so a misconfig cannot
// silently bring a charging station up on an unintended port.

export function assertPhysicalHardwarePortLock(config: OcppHardwareConfig): void {
  if (isPhysicalHardwareState(config.testState) && config.wsPort !== DEFAULT_OCPP_WS_PORT) {
    throw new Error(
      `[OCPP CONFIG] physical_hardware mode is locked to port ${DEFAULT_OCPP_WS_PORT}; ` +
        `got ${config.wsPort}. Refusing to bind a relocated port for a live BESEN station.`,
    );
  }
}

// ─── Bench presets — swap ACTIVE_HARDWARE_CONFIG.testState to toggle instantly ─

const MOCK_HARNESS_STATE: HardwareTestState = {
  status: 'mock_harness',
  simulatedChargerId: 'CP-DC-30KW-SIM-001',
};

const PHYSICAL_BESEN_STATE: HardwareTestState = {
  status: 'physical_hardware',
  activeChargerId: 'CP-BESEN-PILOT-001',
  firmwareVersion: '1.0.0',
};

// ─── Active testing config (edit testState to switch bench mode) ──────────────

export const ACTIVE_HARDWARE_CONFIG: OcppHardwareConfig = {
  wsPort: loadOcppWsPortFromEnv(),
  // testState: MOCK_HARNESS_STATE,
  testState: PHYSICAL_BESEN_STATE,
};

export { MOCK_HARNESS_STATE, PHYSICAL_BESEN_STATE };
