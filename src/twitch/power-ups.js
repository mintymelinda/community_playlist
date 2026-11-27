export function isSelectableCustomPowerUp(powerUp) {
  return Boolean(
    powerUp?.id &&
    powerUp.is_enabled === true &&
    powerUp.is_user_input_required === true &&
    powerUp.is_paused === false &&
    powerUp.is_in_stock === true
  );
}

export function findSelectableCustomPowerUp(powerUps, id) {
  if (!id) return null;
  return (powerUps || []).find(powerUp => powerUp.id === id && isSelectableCustomPowerUp(powerUp)) || null;
}
