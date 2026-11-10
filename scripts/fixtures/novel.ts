import { characterCount } from "../../src/context.ts";
import type { Message } from "../../src/types.ts";

export interface RecallRule {
  readonly key: string;
  readonly label: string;
  readonly expected: string;
  readonly position: "early" | "middle" | "late";
  readonly all: readonly string[];
  readonly any?: readonly string[];
}
export interface NovelFixture {
  readonly title: string;
  readonly messages: readonly Message[];
  readonly corpus: string;
  readonly characters: number;
  readonly rules: readonly RecallRule[];
}

const rules: readonly RecallRule[] = [
  { key: "age", label: "林舟年龄", expected: "27岁", position: "early", all: [], any: ["27", "二十七"] },
  { key: "hearing", label: "听力限制", expected: "左耳失聪", position: "early", all: ["左耳"], any: ["失聪", "听不见"] },
  { key: "password", label: "交接暗号", expected: "潮落时，灯不灭", position: "middle", all: ["潮落时灯不灭"] },
  { key: "duheng", label: "杜衡生死", expected: "活着", position: "middle", all: [], any: ["活着", "生还", "未死", "没有死"] },
  { key: "boxContent", label: "铁盒真实内容", expected: "半张海图", position: "middle", all: ["半张海图"] },
  { key: "meetingTime", label: "最终会面时间", expected: "周四23:20", position: "late", all: [], any: ["2320", "23点20", "二十三点二十"] },
  { key: "location", label: "第60章末位置", expected: "旧灯塔一层门外", position: "late", all: ["旧灯塔", "门外"] },
  { key: "boxHolder", label: "铁盒持有人", expected: "苏晚", position: "late", all: ["苏晚"] },
  { key: "injury", label: "手部伤势", expected: "右手受伤并包白布", position: "late", all: ["右手"], any: ["受伤", "白布", "包扎"] },
  { key: "gaoqi", label: "高启身份结论", expected: "尚未确认是反派", position: "late", all: [], any: ["未确认", "没有确认", "尚无证据", "不确定", "不能确认", "未证实"] },
];
const anchors: Readonly<Record<number, string>> = {
  1: "【已确认人物设定】林舟27岁，左耳失聪，只能依靠右耳辨听。他没有枪，也不会获得超自然能力。苏晚是调查记者，故事采用第三人称限知视角。",
  8: "【尚未定案】高启可能隐瞒了投递路线，这是林舟的怀疑而非已确认结论，不能因此直接把高启写成反派。",
  15: "【角色猜测，尚未证实】有人猜测铁盒内装着钥匙，盒子当时没有打开；这不能作为铁盒真实内容的定案。",
  25: "【已确认交接暗号】接头人逐字说的是：潮落时，灯不灭。此处是暗号，不是天气描写。",
  30: "【生死状态定案】杜衡还活着。早先的死亡传闻已经被当面见到他本人这一事实推翻，后续必须按杜衡活着处理。",
  38: "【物品内容定案】苏晚打开铁盒，确认里面是半张海图，不是钥匙。早先的钥匙说法只是未开盒前的猜测。",
  44: "【会面安排旧版本】早先约定是周三21:10，此时该约定尚未获得双方最后确认。",
  50: "【会面安排最终版本】双方重新确认会面改为周四23:20，替代所有旧时间。请按这个最终版本理解后续已发生的等待。",
  56: "【伤势定案】林舟的右手被碎玻璃割伤，已缠白布，不能用右手推开沉重铁门。伤势没有在后面几章自动痊愈。",
  59: "【物品归属更新】林舟把铁盒交给苏晚保管，此后铁盒持有人是苏晚，不再是林舟。",
  60: "【当前场景定案】第60章结束时，林舟与苏晚停在旧灯塔一层门外，尚未进入地下泵房。苏晚拿着铁盒，林舟右手仍包白布，左耳失聪依旧。高启是否为反派仍未确认，不能把怀疑当事实。下一章是第61章。",
};

/** 生成不同场景的叙事段落，扩充测试材料但不改动已确认的关键状态。 */
function paragraph(chapter: number, index: number): string {
  const places = ["雾港旧街", "北码头档案室", "旧报社库房", "盐仓外廊", "南岸渡口", "旧电台外围"];
  const people = ["林舟", "苏晚", "陈伯", "唐岑", "许澄", "年轻的抄写员"];
  const objects = ["旧报纸", "货运副本", "发黄的登记册", "潮湿的信封", "空白稿纸", "褪色的照片"];
  const colors = ["暗绿", "灰白", "赭红", "浅褐", "青蓝", "银灰"];
  const place = places[Math.floor((chapter - 1) / 10) % places.length] ?? "雾港旧街";
  const person = people[(index + chapter) % people.length] ?? "林舟";
  const object = objects[(index * 3 + chapter) % objects.length] ?? "旧报纸";
  const color = colors[(index * 5 + chapter) % colors.length] ?? "灰白";
  const sequence = chapter * 137 + index * 11;
  const variants = [
    `${person}在${place}的窗边停了一会儿。${object}压在编号${sequence}的纸袋下面，${color}的边角被雨气浸软。路上的人走得很慢，灯光一格一格亮起来。真正让调查继续下去的并不是一个突然出现的答案，而是那些互相对不上的日期、交接顺序和被划掉的名字。`,
    `那一页${object}没有揭开新的身份，却使${person}意识到，记录与回忆经常只差一个被忽略的先后。${place}外的招牌泛着${color}的旧漆，编号${sequence}旁的墨迹还在。众人把能核实的内容写在一边，把没有证据的推测留在另一边，准备等资料相互印证以后再下判断。`,
    `经过${place}时，${person}记下了今天看到的细节：窗台的水痕、${color}的布帘，以及${object}旁那串并不起眼的编号${sequence}。这些只是这一段调查的环境与过程，不改变人物此前已经确认的伤势、年龄、物品归属或会面安排。港口的日常仍在继续，真正重要的线索需要耐心核对。`,
    `${place}的灯把${object}照出几道浅浅的折痕。${person}没有急着把缺口补成一个漂亮的故事，只把编号${sequence}和${color}纸签的位置记下来。有人讲旧事，有人保持沉默；一段看似无用的叙述也可能在后来获得意义，但在证据到来之前，它仍然只是一段值得保留的叙述。`,
  ];
  return variants[(index + chapter) % variants.length] ?? variants[0] ?? "";
}

/** 构造可调体量的本地合成小说夹具；真实 token 数由提供商接口另行核算。 */
export function createNovelFixture(targetCharacters = 400_000): NovelFixture {
  const header = "《雾港来信》本地合成长上下文测试资料。以下回执由导入脚本生成，不是模型逐章创作结果。故事为无超自然的雾港悬疑叙事。标注为已确认或最终版本的内容是连续性定案，角色猜测不能升级为事实。";
  const sections: string[] = [header];
  const perChapter = Math.max(1000, Math.floor((targetCharacters - characterCount(header)) / 60));
  for (let chapter = 1; chapter <= 60; chapter++) {
    const lines = [`第${chapter}章：雾港调查片段`, anchors[chapter] ?? "本章延续调查过程，没有新增关键人物定案。"];
    let size = characterCount(lines.join("\n\n"));
    let index = 0;
    while (size < perChapter) { const text = paragraph(chapter, index++); lines.push(text); size += characterCount(text) + 2; }
    if (chapter === 60) lines.push(anchors[60] ?? "");
    sections.push(lines.join("\n\n"));
  }
  const messages: Message[] = [];
  for (let index = 0; index < sections.length; index++) {
    messages.push({ role: "user", content: sections[index] ?? "" });
    messages.push({ role: "assistant", content: `【本地导入回执，非模型生成】小说测试资料第${index}组已保存。`, toolCalls: [] });
  }
  const corpus = sections.join("\n\n");
  return { title: "雾港来信", messages, corpus, characters: characterCount(corpus), rules };
}
