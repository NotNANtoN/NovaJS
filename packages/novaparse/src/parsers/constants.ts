// Used for converting from 'frames per' to 'times per second'
export const FPS = 30;

// Speed fields (ship Top Speed, weapon Speed, etc.) are stored as
// pixels/frame * 100 at the original 30fps physics rate (EVN Bible:
// "The weapon's speed (pixels per frame * 100)"). Converting to
// pixels/second: (field / 100) px/frame * FPS frames/s = field * FPS / 100.
// This matches WEAP_SPEED_FACTOR (3/10) used for weapon shot speeds.
export const ShipSpeedConversionFactor = FPS / 100;

// Acceleration shares the same pixels/frame * 100 encoding as speed and
// caps out at the ship's speed, so it uses the same factor: a ship with
// equal speed and acceleration fields reaches top speed in one second.
export const ShipAccelerationConversionFactor = FPS / 100;

// 10 is 30° per second.
export const ShipTurnRateConversionFactor = (30 / 10) * (2 * Math.PI / 360);
//(100 / 30) * (2 * Math.PI / 360);

// 100 is 30° per second
export const OutfitTurnRateConversionFactor = ShipTurnRateConversionFactor / 10;
