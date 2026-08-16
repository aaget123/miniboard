// SVG path 坐标工具：leafer 中 Path 元素的渲染位置 = (x, y) + path 坐标，
// 因此数据契约统一为"path 用画布绝对坐标 + x/y 置 0"。
// 序列化导出时把元素的位移（el.x/el.y）并入 path，避免双重偏移。

const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const CMD_RE = /[AaCcHhLlMmQqSsTtVvZz]/g;

/** 数值格式化：保留 2 位小数并去掉多余的 0（避免平移后出现超长浮点串） */
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * 平移 SVG path 字符串中的绝对坐标：M/L/C/S/Q/T 每对坐标加 (dx, dy)，
 * H 只加 dx、V 只加 dy；A 命令的 rx/ry/rotation/large-arc/sweep 参数不动，
 * 只平移末尾的 x/y。相对命令（小写）不受平移影响，原样保留。
 * dx/dy 均为 0 或 path 为空时原样返回。
 */
export function translatePath(path: string, dx: number, dy: number): string {
  if ((!dx && !dy) || !path) {
    return path;
  }
  // 拆成 [命令, 后续数值] 片段
  const cmds: { idx: number; cmd: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = CMD_RE.exec(path)) !== null) {
    cmds.push({ idx: m.index, cmd: m[0] });
  }
  if (!cmds.length) {
    return path;
  }
  let out = "";
  for (let i = 0; i < cmds.length; i++) {
    const { idx, cmd } = cmds[i];
    const end = i + 1 < cmds.length ? cmds[i + 1].idx : path.length;
    const nums = [...path.slice(idx + 1, end).matchAll(NUM_RE)].map((n) =>
      parseFloat(n[0]),
    );
    out += cmd + " ";
    const upper = cmd.toUpperCase();
    const isAbs = cmd === upper;
    let k = 0;
    while (k < nums.length) {
      let per = 2;
      if (upper === "A") {
        per = 7;
      } else if (upper === "H" || upper === "V") {
        per = 1;
      } else if (upper === "C") {
        per = 6;
      } else if (upper === "S" || upper === "Q" || upper === "T") {
        per = 4;
      }
      const group = nums.slice(k, k + per);
      if (upper === "A") {
        // rx ry rotation large-arc sweep 不参与平移，仅末尾 x/y 平移
        out += group
          .slice(0, 5)
          .map(fmt)
          .join(" ");
        out += " ";
        out += group
          .slice(5)
          .map((v, j) => fmt(isAbs ? v + (j === 0 ? dx : dy) : v))
          .join(" ");
      } else if (per === 1) {
        out += fmt(isAbs ? group[0] + (upper === "H" ? dx : dy) : group[0]);
      } else {
        for (let j = 0; j < group.length; j += 2) {
          out += (j ? " " : "") + fmt(isAbs ? group[j] + dx : group[j]);
          out += " " + fmt(isAbs ? group[j + 1] + dy : group[j + 1]);
        }
      }
      k += per;
    }
    out += " ";
  }
  return out.trim();
}

/**
 * 镜像 SVG path 字符串：绕 axis 轴的 center 处翻转坐标——h（水平翻转）时 x → 2*center - x，
 * v（垂直翻转）时 y → 2*center - y。A 命令的 rx/ry 不变、rotation 取负、sweep 标志翻转
 * （镜像反转弧的扫描方向）；相对命令（小写）原样保留（数据契约保证绝对坐标）。
 * path 为空时原样返回。
 */
export function mirrorPath(
  path: string,
  axis: "h" | "v",
  center: number,
): string {
  if (!path) {
    return path;
  }
  // 拆成 [命令, 后续数值] 片段
  const cmds: { idx: number; cmd: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = CMD_RE.exec(path)) !== null) {
    cmds.push({ idx: m.index, cmd: m[0] });
  }
  if (!cmds.length) {
    return path;
  }
  let out = "";
  for (let i = 0; i < cmds.length; i++) {
    const { idx, cmd } = cmds[i];
    const end = i + 1 < cmds.length ? cmds[i + 1].idx : path.length;
    const nums = [...path.slice(idx + 1, end).matchAll(NUM_RE)].map((n) =>
      parseFloat(n[0]),
    );
    out += cmd + " ";
    const upper = cmd.toUpperCase();
    const isAbs = cmd === upper;
    const mirrorX = isAbs && axis === "h";
    const mirrorY = isAbs && axis === "v";
    let k = 0;
    while (k < nums.length) {
      let per = 2;
      if (upper === "A") {
        per = 7;
      } else if (upper === "H" || upper === "V") {
        per = 1;
      } else if (upper === "C") {
        per = 6;
      } else if (upper === "S" || upper === "Q" || upper === "T") {
        per = 4;
      }
      const group = nums.slice(k, k + per);
      if (upper === "A") {
        // rx ry rotation large-arc sweep 不参与镜像（sweep 翻转），仅末尾 x/y 镜像
        const [rx, ry, rot, laf, sf, x, y] = group;
        out += [
          rx,
          ry,
          -rot,
          laf,
          sf === 1 ? 0 : 1,
          mirrorX ? 2 * center - x : x,
          mirrorY ? 2 * center - y : y,
        ]
          .map(fmt)
          .join(" ");
      } else if (per === 1) {
        // H 只有 x 坐标、V 只有 y 坐标：仅对应轴的镜像生效，另一轴原样保留
        const v = group[0];
        out += fmt(
          (upper === "H" ? mirrorX : mirrorY) ? 2 * center - v : v,
        );
      } else {
        for (let j = 0; j < group.length; j += 2) {
          out +=
            (j ? " " : "") +
            fmt(mirrorX ? 2 * center - group[j] : group[j]);
          out +=
            " " + fmt(mirrorY ? 2 * center - group[j + 1] : group[j + 1]);
        }
      }
      k += per;
    }
    out += " ";
  }
  return out.trim();
}
