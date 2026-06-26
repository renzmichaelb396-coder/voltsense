// Pilot AC location seed matrix — 10-site EOY rollout (Law §1.2 QR deep links)
// Hardcoded registry for provisioning before DB migration seeds land.
// Site 01 anchor: Go Hotels Plus Mandaluyong. All units: 32 A three-phase / 22 kW AC.

import type { phaseEnum } from './schema.js';

// ─── Domain types ─────────────────────────────────────────────────────────────

export type PilotPhase = (typeof phaseEnum.enumValues)[number];

export type PilotPropertyClass =
  | 'hotel'
  | 'mixed_use_residential'
  | 'retail_mall'
  | 'office_park'
  | 'transport_hub';

export type PilotLocationRecord = {
  readonly siteNumber: number;
  readonly siteId: string;
  readonly slug: string;
  readonly name: string;
  readonly propertyClass: PilotPropertyClass;
  readonly address: string;
  readonly city: string;
  readonly feederBreakerAmps: 32;
  readonly feederCapacityWatts: number;
  readonly phase: PilotPhase;
  readonly chargePointId: string;
  readonly connectorCount: number;
  readonly provisioningStatus: 'planned' | 'provisioned' | 'operational';
};

// ─── 22 kW three-phase draw ceiling (04-ALIBABA §1.3) ────────────────────────

const AC_FEEDER_BREAKER_AMPS = 32 as const;
const AC_FEEDER_CAPACITY_WATTS = 22_000 as const;
const AC_PHASE: PilotPhase = 'three';

// ─── 10-site pilot matrix ─────────────────────────────────────────────────────

export const PILOT_LOCATIONS_REGISTRY: readonly PilotLocationRecord[] = [
  {
    siteNumber: 1,
    siteId: 'a1000001-0001-4001-8001-000000000001',
    slug: 'go-hotels-plus-mandaluyong',
    name: 'Go Hotels Plus Mandaluyong',
    propertyClass: 'hotel',
    address: 'Maysilo Circle, Mandaluyong City',
    city: 'Mandaluyong',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-001-go-hotels-mgy',
    connectorCount: 2,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 2,
    siteId: 'a1000002-0002-4002-8002-000000000002',
    slug: 'sm-light-residences',
    name: 'SM Light Residences',
    propertyClass: 'mixed_use_residential',
    address: 'Madison Street, Mandaluyong City',
    city: 'Mandaluyong',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-002-sm-light',
    connectorCount: 2,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 3,
    siteId: 'a1000003-0003-4003-8003-000000000003',
    slug: 'robinsons-forum-mandaluyong',
    name: 'Robinsons Forum',
    propertyClass: 'retail_mall',
    address: 'EDSA corner Pioneer Street, Mandaluyong City',
    city: 'Mandaluyong',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-003-robinsons-forum',
    connectorCount: 4,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 4,
    siteId: 'a1000004-0004-4004-8004-000000000004',
    slug: 'greenfield-district',
    name: 'Greenfield District',
    propertyClass: 'office_park',
    address: 'Mayflower Street, Mandaluyong City',
    city: 'Mandaluyong',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-004-greenfield',
    connectorCount: 3,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 5,
    siteId: 'a1000005-0005-4005-8005-000000000005',
    slug: 'ayala-malls-feliz',
    name: 'Ayala Malls Feliz',
    propertyClass: 'retail_mall',
    address: 'Marcos Highway, Pasig City',
    city: 'Pasig',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-005-ayala-feliz',
    connectorCount: 4,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 6,
    siteId: 'a1000006-0006-4006-8006-000000000006',
    slug: 'estancia-capitol-commons',
    name: 'Estancia at Capitol Commons',
    propertyClass: 'retail_mall',
    address: 'Meralco Avenue, Pasig City',
    city: 'Pasig',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-006-estancia',
    connectorCount: 3,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 7,
    siteId: 'a1000007-0007-4007-8007-000000000007',
    slug: 'uptown-mall-bgc',
    name: 'Uptown Mall BGC',
    propertyClass: 'retail_mall',
    address: '9th Avenue, Bonifacio Global City, Taguig',
    city: 'Taguig',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-007-uptown-bgc',
    connectorCount: 4,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 8,
    siteId: 'a1000008-0008-4008-8008-000000000008',
    slug: 'ayala-malls-vertis-north',
    name: 'Ayala Malls Vertis North',
    propertyClass: 'retail_mall',
    address: 'North Avenue, Quezon City',
    city: 'Quezon City',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-008-vertis-north',
    connectorCount: 4,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 9,
    siteId: 'a1000009-0009-4009-8009-000000000009',
    slug: 'sm-moa-annex',
    name: 'SM Mall of Asia Annex',
    propertyClass: 'retail_mall',
    address: 'Seaside Boulevard, Pasay City',
    city: 'Pasay',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-009-sm-moa',
    connectorCount: 6,
    provisioningStatus: 'planned',
  },
  {
    siteNumber: 10,
    siteId: 'a1000010-0010-4010-8010-000000000010',
    slug: 'festival-mall-alabang',
    name: 'Festival Mall Alabang',
    propertyClass: 'retail_mall',
    address: 'Corporate Avenue, Filinvest City, Muntinlupa',
    city: 'Muntinlupa',
    feederBreakerAmps: AC_FEEDER_BREAKER_AMPS,
    feederCapacityWatts: AC_FEEDER_CAPACITY_WATTS,
    phase: AC_PHASE,
    chargePointId: 'cp-pilot-010-festival-alabang',
    connectorCount: 6,
    provisioningStatus: 'planned',
  },
] as const;

// ─── Registry accessors ────────────────────────────────────────────────────────

export function getPilotLocationBySlug(slug: string): PilotLocationRecord | undefined {
  return PILOT_LOCATIONS_REGISTRY.find((site) => site.slug === slug);
}

export function getPilotLocationBySiteNumber(siteNumber: number): PilotLocationRecord | undefined {
  return PILOT_LOCATIONS_REGISTRY.find((site) => site.siteNumber === siteNumber);
}

export function getPilotLocationByChargePointId(
  chargePointId: string,
): PilotLocationRecord | undefined {
  return PILOT_LOCATIONS_REGISTRY.find((site) => site.chargePointId === chargePointId);
}

export const PILOT_SITE_COUNT = PILOT_LOCATIONS_REGISTRY.length;
