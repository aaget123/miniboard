import type { ElementData } from "../types";

export type Snapshot = ElementData[];

/**
 * 快照式历史栈：每次操作后保存一份元素序列化快照。
 * 简单可靠，适合元素数量不大的白板场景。
 */
export class History {
  private stack: Snapshot[] = [];
  private index = -1;

  constructor(private limit = 60) {}

  /** 记录一个新快照（裁剪 redo 分支，限制深度） */
  push(snapshot: Snapshot) {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) {
      this.stack.shift();
    }
    this.index = this.stack.length - 1;
  }

  undo(): Snapshot | null {
    if (this.index <= 0) {
      return null;
    }
    this.index -= 1;
    return this.stack[this.index];
  }

  redo(): Snapshot | null {
    if (this.index >= this.stack.length - 1) {
      return null;
    }
    this.index += 1;
    return this.stack[this.index];
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  clear() {
    this.stack = [];
    this.index = -1;
  }
}
