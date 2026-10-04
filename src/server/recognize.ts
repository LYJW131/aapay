import { z } from 'zod';
import { LIMITS } from '../shared/limits.ts';
import { MAX_AMOUNT } from '../shared/money.ts';
import { isoDate } from '../shared/schema.ts';
import type { BillDraft } from '../shared/types.ts';
import { AppError } from './core/errors.ts';
import type { AiRunner } from './platform.ts';

export const RECOGNIZE_MODEL = '@cf/qwen/qwen3.8-27b';

const instructions = (today: string) =>
  [
    '你是记账助手，从用户上传的账单图片（购物小票、微信或支付宝付款截图、外卖或打车订单等）中提取一笔支出。',
    '- title：这笔钱花在哪，2 到 8 个字，优先用商家简称或消费类别，如「瑞幸咖啡」「超市购物」「外卖」「打车」。',
    '- amount：最终实际支付的金额，单位元，是扣除优惠、红包后的实付数，不是原价、小计或单个商品的价格。',
    `- date：消费日期，格式 YYYY-MM-DD；图片上没有年份时按今天（${today}）推断，看不出日期时为 null。`,
    '图片不是账单或看不清时，三个字段都为 null。',
  ].join('\n');

const reply = z.object({
  title: z.string().nullable(),
  amount: z.number().nullable(),
  date: z.string().nullable(),
});

const replySchema = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'] },
    date: { type: ['string', 'null'] },
  },
  required: ['title', 'amount', 'date'],
  additionalProperties: false,
};

type Completion = { choices?: { message?: { content?: unknown } }[]; response?: unknown };

function contentOf(output: unknown): unknown {
  const completion = output as Completion;
  const content = completion?.choices?.[0]?.message?.content ?? completion?.response;
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return null;
  }
}

export async function recognizeBill(ai: AiRunner, image: string, today: string): Promise<BillDraft> {
  let output: unknown;
  try {
    output = await ai(RECOGNIZE_MODEL, {
      messages: [
        { role: 'system', content: instructions(today) },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: '识别这张账单' },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'bill', schema: replySchema, strict: true } },
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      max_completion_tokens: 200,
    });
  } catch (err) {
    console.error('recognize failed', err);
    throw new AppError(502, '识别服务暂时不可用，请稍后再试');
  }

  const parsed = reply.safeParse(contentOf(output));
  if (!parsed.success) {
    console.error('recognize unexpected output', JSON.stringify(output).slice(0, 500));
    throw new AppError(502, '没能识别这张图片，请换一张再试');
  }

  const { title, amount, date } = parsed.data;
  const cents = amount === null ? 0 : Math.round(amount * 100);
  const draft: BillDraft = {
    title: title?.trim().slice(0, LIMITS.title) || null,
    amount: cents > 0 && cents <= MAX_AMOUNT ? cents : null,
    date: date && isoDate.safeParse(date).success ? date : null,
  };
  if (!draft.title && !draft.amount) throw new AppError(422, '没有在图片里找到账单信息');
  return draft;
}
