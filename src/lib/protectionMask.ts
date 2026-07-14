export type MaskPoint = {
  x: number;
  y: number;
};

function paintCircle(
  mask: Uint8Array,
  width: number,
  height: number,
  center: MaskPoint,
  radius: number,
  protectedValue: number,
): void {
  const safeRadius = Math.max(1, radius);
  const startX = Math.max(0, Math.floor(center.x - safeRadius));
  const endX = Math.min(width - 1, Math.ceil(center.x + safeRadius));
  const startY = Math.max(0, Math.floor(center.y - safeRadius));
  const endY = Math.min(height - 1, Math.ceil(center.y + safeRadius));
  const radiusSquared = safeRadius * safeRadius;

  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy <= radiusSquared) {
        mask[y * width + x] = protectedValue;
      }
    }
  }
}

export function paintProtectionStroke(
  mask: Uint8Array,
  width: number,
  height: number,
  start: MaskPoint,
  end: MaskPoint,
  radius: number,
  protect: boolean,
): void {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
  const protectedValue = protect ? 1 : 0;

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    paintCircle(
      mask,
      width,
      height,
      {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      },
      radius,
      protectedValue,
    );
  }
}
