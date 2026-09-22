import { ConnectorError, ConnectorErrorCodes, ConnectorType, ConnectorConfigFormItemType } from '@logto/connector-kit';
import { z } from 'zod';
import { connectorId, sendSesVerification, TencentSesError } from './ses.js';
const configGuard = z.object({ secretId: z.string().min(1), secretKey: z.string().min(1), region: z.enum(['ap-guangzhou','ap-hongkong']),
  fromEmail: z.string().email(), templateId: z.number().int().positive(), codeVariable: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/u), subject: z.string().min(1).max(128) });
export default async function createTencentSesConnector({ getConfig }) {
  return {
    type: ConnectorType.Email,
    metadata: { id: connectorId, target: connectorId, platform: null, name: {en:'Tencent Cloud SES','zh-CN':'腾讯云邮件推送 SES'},
      description: {en:'Verification emails through Tencent Cloud SES API templates.','zh-CN':'使用腾讯云 SES API 和审核通过的模板发送验证邮件。'},
      logo:'../@logto-connector-tencent-sms/logo.svg',logoDark:null,readme:'./README.md',
      formItems:[
        ...['secretId','secretKey','region','fromEmail','codeVariable','subject'].map((key)=>({key,label:key,type:ConnectorConfigFormItemType.Text,required:true})),
        {key:'templateId',label:'Template ID',type:ConnectorConfigFormItemType.Number,required:true},
      ],
    },
    configGuard,
    async sendMessage(data, inputConfig) {
      const parsed = configGuard.safeParse(inputConfig ?? await getConfig(connectorId));
      if (!parsed.success) throw new ConnectorError(ConnectorErrorCodes.InvalidConfig, 'Invalid Tencent SES configuration.');
      try { await sendSesVerification(data, parsed.data); }
      catch (error) { throw new ConnectorError(ConnectorErrorCodes.General, error instanceof TencentSesError ? error.message : 'Tencent SES delivery request failed.'); }
    },
  };
}
