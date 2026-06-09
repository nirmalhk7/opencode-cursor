export class LineBuffer {
  private pendingParts: string[] = [];
  private decoder = new TextDecoder();

  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk);
    if (!text) {
      return [];
    }

    if (!text.includes("\n")) {
      this.appendPending(text);
      return [];
    }

    const input = this.takePending() + text;
    return this.extractCompletedLines(input);
  }

  flush(): string[] {
    const remainder = this.takePending();
    if (!remainder.trim()) {
      return [];
    }

    const normalized = remainder.endsWith("\r")
      ? remainder.slice(0, -1)
      : remainder;

    if (!normalized.trim()) {
      return [];
    }

    return [normalized];
  }

  private appendPending(text: string): void {
    this.pendingParts.push(text);
  }

  private takePending(): string {
    if (this.pendingParts.length === 0) {
      return "";
    }

    const joined = this.pendingParts.length === 1
      ? this.pendingParts[0]
      : this.pendingParts.join("");
    this.pendingParts = [];
    return joined;
  }

  private extractCompletedLines(input: string): string[] {
    const completed: string[] = [];
    let lineStart = 0;

    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) !== 10) {
        continue;
      }

      let line = input.slice(lineStart, i);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.trim()) {
        completed.push(line);
      }
      lineStart = i + 1;
    }

    if (lineStart < input.length) {
      this.appendPending(input.slice(lineStart));
    }

    return completed;
  }
}
