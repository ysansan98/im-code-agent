export type ApprovalKind = "read" | "write" | "exec" | "network";
export type ApprovalRiskLevel = "low" | "medium" | "high";
export type ApprovalDecisionValue = "approved" | "rejected";

export type ApprovalRequest = {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  title: string;
  cwd: string;
  target?: string;
  command?: string;
  diffPreview?: string;
  reason?: string;
  riskLevel: ApprovalRiskLevel;
  createdAt: string;
  expiresAt: string;
};

export type ApprovalDecision = {
  requestId: string;
  taskId: string;
  decision: ApprovalDecisionValue;
  comment?: string;
  decidedAt: string;
  decidedBy: string;
};
