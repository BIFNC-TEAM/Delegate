/** Inspect only host-produced status fields, never prose returned in content/reply. */
export function createServiceRequestReceiptGuard() {
  let submitted = false;
  let approved = false;
  function observe(value: unknown) {
    if (Array.isArray(value)) { value.forEach(observe); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && record.direction === "visitor_to_owner") {
      if (["pending", "accepted", "rejected", "disabled"].includes(String(record.status))) submitted = true;
      if (record.status === "accepted") approved = true;
    }
    if (typeof record.handoffId === "string" && ["created", "reused", "active_request_exists"].includes(String(record.status))) submitted = true;
    for (const key of ["items", "results", "request"]) if (record[key]) observe(record[key]);
  }
  return {
    observe,
    permits(text: string) {
      if (/已(?:经|成功)?(?:为您|为你|帮您|帮你)?(?:提交|登记)|(?:request|application) (?:has been |was )?submitted/i.test(text) && !submitted) return false;
      if (/已(?:经)?(?:批准|获批)|申请已(?:经)?接受|owner已(?:经)?接受|(?:request|application) (?:has been |was )?approved/i.test(text) && !approved) return false;
      // A handoff registration is never proof that a person has joined.
      if (/真人已(?:经)?(?:加入|接入)|本人已(?:经)?接手|human (?:has )?joined/i.test(text)) return false;
      return true;
    },
  };
}
