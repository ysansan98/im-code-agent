export const APPROVAL_KINDS = ["read", "write", "exec", "network"] as const;
export const APPROVAL_RISK_LEVELS = ["low", "medium", "high"] as const;
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];
export type ApprovalDecisionValue = (typeof APPROVAL_DECISIONS)[number];

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
