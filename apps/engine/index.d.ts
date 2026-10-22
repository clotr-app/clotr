export interface Pattern {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly severity: "high" | "medium" | "low";
}

export interface DetectionResult extends Pattern {
  readonly matches: string[];
  readonly asks?: string[];
}

export interface DetectionResults extends Array<DetectionResult> {
  readonly truncated?: boolean;
}

export declare const PATTERNS: readonly Pattern[];
export declare function detect(text: string): DetectionResults;
export declare function redact(text: string, results: readonly DetectionResult[]): string;
