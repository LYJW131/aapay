import { defineMessages } from './i18n.ts';

export const CATEGORIES = ['food', 'groceries', 'transport', 'lodging', 'fun', 'shopping', 'housing', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const isCategory = (value: unknown): value is Category => (CATEGORIES as readonly unknown[]).includes(value);

export const CATEGORY_EMOJI: Record<Category, string> = {
  food: '🍜',
  groceries: '🛒',
  transport: '🚕',
  lodging: '🏨',
  fun: '🎉',
  shopping: '🛍️',
  housing: '🏠',
  other: '📦',
};

export const CATEGORY_LABELS = defineMessages<Record<Category, string>>({
  'zh-CN': {
    food: '餐饮',
    groceries: '超市日用',
    transport: '交通',
    lodging: '住宿',
    fun: '娱乐',
    shopping: '购物',
    housing: '房租水电',
    other: '其他',
  },
  en: {
    food: 'Food & drinks',
    groceries: 'Groceries',
    transport: 'Transport',
    lodging: 'Lodging',
    fun: 'Entertainment',
    shopping: 'Shopping',
    housing: 'Housing & bills',
    other: 'Other',
  },
});

const KEYWORDS: [Category, string[]][] = [
  ['groceries', ['超市', '便利店', '买菜', '菜市场', '生鲜', '日用', 'grocery', 'groceries', 'supermarket']],
  ['housing', ['房租', '水费', '电费', '水电', '燃气', '煤气', '网费', '宽带', '物业', 'rent', 'utilities', 'electricity', 'internet']],
  ['lodging', ['酒店', '民宿', '住宿', '旅馆', '宾馆', 'hotel', 'airbnb', 'hostel']],
  ['transport', ['打车', '滴滴', '出租', '地铁', '公交', '高铁', '火车', '动车', '机票', '航班', '加油', '停车', '过路费', '高速', 'taxi', 'uber', 'train', 'flight', 'metro', 'subway', 'bus', 'gas', 'parking']],
  ['fun', ['电影', 'ktv', '门票', '游戏', '演唱会', '剧本杀', '密室', '景区', '酒吧', 'movie', 'ticket', 'concert', 'game', 'bar']],
  ['shopping', ['淘宝', '京东', '拼多多', '衣服', '鞋', '购物', 'shopping', 'clothes', 'amazon']],
  ['food', ['早餐', '早饭', '午饭', '午餐', '晚饭', '晚餐', '夜宵', '宵夜', '外卖', '火锅', '烧烤', '咖啡', '奶茶', '饮料', '餐', '饭', '面', '小吃', '零食', '水果', 'coffee', 'breakfast', 'lunch', 'dinner', 'brunch', 'snack', 'drink', 'tea', 'restaurant', 'pizza', 'burger']],
];

export function guessCategory(title: string): Category | null {
  const text = title.trim().toLowerCase();
  if (!text) return null;
  for (const [category, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) return category;
  }
  return null;
}
