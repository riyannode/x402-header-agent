export class X402ArcError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "X402ArcError";
    this.code = code;
    this.cause = cause;
  }
}

export class PolicyViolation extends X402ArcError {
  constructor(message: string, cause?: unknown) {
    super(message, "POLICY_VIOLATION", cause);
    this.name = "PolicyViolation";
  }
}

export class UnsupportedPaymentError extends X402ArcError {
  constructor(message: string, cause?: unknown) {
    super(message, "UNSUPPORTED_PAYMENT", cause);
    this.name = "UnsupportedPaymentError";
  }
}

export class GatewayPaymentError extends X402ArcError {
  constructor(message: string, cause?: unknown) {
    super(message, "GATEWAY_PAYMENT_ERROR", cause);
    this.name = "GatewayPaymentError";
  }
}

export class ConfigurationError extends X402ArcError {
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIGURATION_ERROR", cause);
    this.name = "ConfigurationError";
  }
}
