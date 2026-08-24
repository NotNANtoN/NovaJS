// Used for converting from 'frames per' to 'times per second'
export const FPS = 30;
export const framesToMilliseconds = (frames: number) => frames / FPS * 1000;

// 10 is 30° per second.
export const ShipTurnRateConversionFactor = (30 / 10) * (2 * Math.PI / 360);
//(100 / 30) * (2 * Math.PI / 360);

// 100 is 30° per second
export const OutfitTurnRateConversionFactor = ShipTurnRateConversionFactor / 10;

/**
 * Convert Nova ship acceleration and speed fields to NovaJS physics units.
 *
 * The EV Nova Bible describes Accel and Speed as gameplay values (300 is the
 * average for each), but does not state the coordinate-unit conversion. Until
 * the original engine conversion is verified, use the project-documented and
 * community-reported 3/10 mapping in one place.
 */
export const ShipVelocityConversionFactor = 3 / 10;
