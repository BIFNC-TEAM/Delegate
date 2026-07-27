import {
  serviceEntitlementWalletInternal,
  type ConsumeServiceEntitlementInput,
  type GrantServiceEntitlementInput,
  type RefundGrantedServiceEntitlementInput,
  type ReleaseServiceEntitlementInput,
  type ReserveServiceEntitlementInput,
  type ServiceEntitlementClient,
} from "./service-entitlements";

/**
 * Explicit package-internal bridge for the wallet's dual-ledger transaction.
 *
 * Do not export this module from src/index.ts. The public entitlement API must
 * never mutate the reserved wallet product independently of wallet balances.
 */
export function grantAgentWalletServiceCreditEntitlement(
  input: Omit<GrantServiceEntitlementInput, "productCode">,
  client: ServiceEntitlementClient,
) {
  return serviceEntitlementWalletInternal.grant(input, client);
}

export function reserveAgentWalletServiceCreditEntitlement(
  input: Omit<ReserveServiceEntitlementInput, "productCode">,
  client: ServiceEntitlementClient,
) {
  return serviceEntitlementWalletInternal.reserve(input, client);
}

export function consumeAgentWalletServiceCreditEntitlement(
  input: Omit<ConsumeServiceEntitlementInput, "productCode">,
  client: ServiceEntitlementClient,
) {
  return serviceEntitlementWalletInternal.consume(input, client);
}

export function releaseAgentWalletServiceCreditEntitlement(
  input: Omit<ReleaseServiceEntitlementInput, "productCode">,
  client: ServiceEntitlementClient,
) {
  return serviceEntitlementWalletInternal.release(input, client);
}

export function refundAgentWalletServiceCreditEntitlement(
  input: Omit<RefundGrantedServiceEntitlementInput, "productCode">,
  client: ServiceEntitlementClient,
) {
  return serviceEntitlementWalletInternal.refund(input, client);
}
