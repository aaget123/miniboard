// 元素局部坐标 ↔ 画布绝对坐标换算（AI 感知/修改用）。
// leafer 中 line/arrow 的 points、path 的 path 字符串均为"相对元素原点"的局部坐标，
// 元素 x/y 是局部坐标系的画布位置，rotation 绕元素包围盒中心旋转。
// AI 上下文统一输出画布绝对坐标，写回时反向换算，避免模型把相对值当绝对值导致元素错位。

export type CoordBox = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
};

/** 局部点 → 画布绝对坐标（叠加 x/y 偏移与 rotation 中心旋转） */
export function localToCanvas(box: CoordBox, p: { x: number; y: number }) {
  const { rotation, x = 0, y = 0, width = 0, height = 0 } = box;
  const cx = width / 2;
  const cy = height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (!rotation) {
    return { x: x + p.x, y: y + p.y };
  }
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: x + dx * cos - dy * sin + cx,
    y: y + dx * sin + dy * cos + cy,
  };
}

/** 画布绝对坐标 → 局部点（rotation 中心旋转的逆变换） */
export function canvasToLocal(box: CoordBox, p: { x: number; y: number }) {
  const { rotation, x = 0, y = 0, width = 0, height = 0 } = box;
  const cx = width / 2;
  const cy = height / 2;
  const dx = p.x - x - cx;
  const dy = p.y - y - cy;
  if (!rotation) {
    return { x: dx + cx, y: dy + cy };
  }
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: dx * cos - dy * sin + cx,
    y: dx * sin + dy * cos + cy,
  };
}

/** 数值保留 1 位小数（与序列化一致） */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
