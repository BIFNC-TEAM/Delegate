export const PUBLIC_WALLET_UPDATED_EVENT = "delegate:public-wallet-updated";

export type PublicWalletUpdatedDetail = {
  representativeSlug: string;
  serviceCreditsAvailable: number;
  serviceCreditsReserved: number;
};

export function publishPublicWalletUpdate(
  detail: PublicWalletUpdatedDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<PublicWalletUpdatedDetail>(
      PUBLIC_WALLET_UPDATED_EVENT,
      { detail },
    ),
  );
}
