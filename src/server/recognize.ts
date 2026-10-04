import { z } from 'zod';
import { LIMITS } from '../shared/limits.ts';
import { MAX_AMOUNT } from '../shared/money.ts';
import { isoDate } from '../shared/schema.ts';
import type { BillDraft } from '../shared/types.ts';
import { AppError } from './core/errors.ts';

export const MAX_BILLS = 30;

const instructions = (today: string) =>
  [
    '你是记账助手，从用户上传的图片中提取支出记录。图片可能是购物小票、付款详情、外卖或打车订单，也可能是微信、支付宝等 App 的账单列表，里面有多笔交易。',
    '每笔支出输出一项：',
    '- title：这笔钱花在哪，2 到 8 个字，优先用商家简称或消费类别，如「瑞幸咖啡」「超市购物」「外卖」「打车」。',
    '- amount：这笔实际支付的金额，单位元，正数；是扣除优惠、红包后的实付数，不是原价、小计或单个商品的价格。',
    `- date：消费日期，格式 YYYY-MM-DD；图片上没有年份时按今天（${today}）推断，看不出日期时为 null。`,
    '只提取支出：收入、退款、转入不要；月度或分类的合计、统计数字不是交易，也不要。',
    '一张小票或一个订单只算一笔，不要按商品拆开。按图片中从上到下的顺序输出。',
    `图片里没有支出或看不清时，items 为空数组。最多 ${MAX_BILLS} 项。`,
  ].join('\n');

const bill = z.object({
  title: z.string().nullable(),
  amount: z.number().nullable(),
  date: z.string().nullable(),
});
const reply = z.object({ items: z.array(bill) });

const replySchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', nullable: true },
          amount: { type: 'number', nullable: true },
          date: { type: 'string', nullable: true },
        },
        required: ['title', 'amount', 'date'],
      },
    },
  },
  required: ['items'],
};

type Reply = { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };

function contentOf(output: Reply): unknown {
  const text = output.candidates?.[0]?.content?.parts
    ?.filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

export async function recognizeBills(
  gemini: { apiKey: string; model: string },
  image: string,
  today: string,
): Promise<{ items: BillDraft[] }> {
  const [, mimeType, data] = image.match(/^data:(image\/\w+);base64,(.*)$/)!;
  let output: Reply;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gemini.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': gemini.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions(today) }] },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }, { text: '识别这张图片里的支出' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: replySchema,
          temperature: 0,
          maxOutputTokens: 2000,
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    output = (await res.json()) as Reply;
  } catch (err) {
    console.error('recognize failed', err);
    throw new AppError(502, '识别服务暂时不可用，请稍后再试');
  }

  const parsed = reply.safeParse(contentOf(output));
  if (!parsed.success) {
    console.error('recognize unexpected output', JSON.stringify(output).slice(0, 500));
    throw new AppError(502, '没能识别这张图片，请换一张再试');
  }

  const items = parsed.data.items
    .slice(0, MAX_BILLS)
    .map(({ title, amount, date }): BillDraft => {
      const cents = amount === null ? 0 : Math.round(Math.abs(amount) * 100);
      return {
        title: title?.trim().slice(0, LIMITS.title) || null,
        amount: cents > 0 && cents <= MAX_AMOUNT ? cents : null,
        date: date && isoDate.safeParse(date).success ? date : null,
      };
    })
    .filter((item) => item.title || item.amount);
  if (items.length === 0) throw new AppError(422, '没有在图片里找到账单信息');
  return { items };
}
