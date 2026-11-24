import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createRepresentative, getRepresentativeSetupSnapshot, listRepresentativeDirectoryItems, updateRepresentativeSetup } from "../src/representative-setup";
import { prisma } from "../src/prisma";
import { defaultKnowledgeSettings } from "@delegate/domain/representative-knowledge-settings";
import { publishRepresentativeVersion } from "../src/conversation-platform";

const enabled = process.env.DELEGATE_ONBOARDING_E2E === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) throw new Error("isolated_test_database_required");
}
(enabled ? describe : describe.skip)("onboarding against PostgreSQL", () => {
  afterAll(() => prisma.$disconnect());
  it("creates once under concurrent retries, remains private, persists fields and rejects foreign reuse", async () => {
    const owner = await prisma.owner.create({ data: { displayName: "真实测试昵称" } });
    const foreign = await prisma.owner.create({ data: { displayName: "另一个账号" } });
    const onboarding = { version: 1 as const, requestId: randomUUID(), step: 3, fields: ["产品" as const], customField: "", name: "测试顾问", services: "整理产品需求", tone: 2, avatarUrl: "" };
    const input = { ownerName: "不能伪造昵称", representativeName: onboarding.name, onboarding };
    const [a, b] = await Promise.all([createRepresentative(input, { ownerId: owner.id }), createRepresentative(input, { ownerId: owner.id })]);
    expect(a.id).toBe(b.id); expect(a.slug).toMatch(/^[1-9][0-9]{6}$/);
    expect(a.ownerName).toBe(owner.displayName); expect(a.languages).toEqual(["zh", "en"]);
    expect(a.tagline).toBe(onboarding.services); expect(a.knowledgePack.identitySummary).toContain(owner.displayName);
    expect(a.publicMode).toBe(false);
    const row = await prisma.representative.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.lifecycleState).toBe("DRAFT"); expect(row.activeVersionId).toBeNull();
    expect(await prisma.representative.count({ where: { ownerId: owner.id } })).toBe(1);
    await expect(createRepresentative(input, { ownerId: foreign.id })).rejects.toThrow("Invalid creation request");
    const saved = await updateRepresentativeSetup({ representativeSlug: a.slug, input: { ...a, tagline: "更新后的产品服务" }, syncOpenViking: false });
    expect((await getRepresentativeSetupSnapshot(a.slug))?.tagline).toBe(saved.tagline);
    expect((await listRepresentativeDirectoryItems(owner.id))[0]?.tagline).toBe(saved.tagline);
    expect(await listRepresentativeDirectoryItems(foreign.id)).toEqual([]);
    await expect(updateRepresentativeSetup({ representativeSlug: a.slug, input: { ...saved, name: "名".repeat(61) }, syncOpenViking: false })).rejects.toThrow("字数上限");
    await expect(updateRepresentativeSetup({ representativeSlug: a.slug, input: { ...saved, avatarUrl: "https://untrusted.example/avatar.jpg" }, syncOpenViking: false })).rejects.toThrow("Invalid avatar reference");
    const settings = defaultKnowledgeSettings();
    const asset=await prisma.knowledgeAsset.create({data:{ownerId:owner.id,kind:"TEXT",title:"草稿关联测试",status:"READY"}});
    settings.files=[{id:asset.id,allowDownload:true}];
    settings.boundaries[0]!.action = "decline";
    const staged=await updateRepresentativeSetup({representativeSlug:a.slug,input:{...saved,knowledgeSettings:settings},syncOpenViking:false});
    expect((await getRepresentativeSetupSnapshot(a.slug))?.knowledgeSettings).toEqual(settings);
    expect(await prisma.knowledgeAssetRepresentative.count({where:{representativeId:a.id}})).toBe(0);
    await expect(updateRepresentativeSetup({representativeSlug:a.slug,input:{...staged,knowledgeSettings:{...settings,files:[{id:"foreign-or-missing",allowDownload:true}]}},syncOpenViking:false})).rejects.toThrow("不可用");
    await expect(updateRepresentativeSetup({representativeSlug:a.slug,input:{...staged,knowledgeSettings:{...settings,featuredFaqIds:["missing-faq"]}},syncOpenViking:false})).rejects.toThrow("展示项");
    await expect(publishRepresentativeVersion({representativeSlug:a.slug,publishedBy:owner.id,ownerId:owner.id})).rejects.toThrow("尚未接通");
  });
});
