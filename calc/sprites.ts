// Sprite utility functions

/**
 * Get Pokemon HOME sprite path
 */
export function getPokemonHomeSpritePath(
  nationalDexNumber: number,
  formIndex: number = 0,
): string {
  const paddedNumber = nationalDexNumber.toString().padStart(4, "0");
  const formSuffix = formIndex > 0 ? `_${formIndex}` : "";
  return `/images/spriteshome/${paddedNumber}${formSuffix}.png`;
}

/**
 * Get item sprite path
 */
export function getItemSpritePath(itemId: number): string {
  const paddedId = itemId.toString().padStart(4, "0");
  return `/images/itemsprite/${paddedId}.png`;
}

/**
 * Get Pokemon sprite (deprecated, use getPokemonHomeSpritePath)
 */
export function getPokemonSprite(species: string, form?: string): string {
  // Placeholder implementation
  return `/images/sprites/${species}${form ? `-${form}` : ""}.png`;
}
