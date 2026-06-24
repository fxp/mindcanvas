// A REAL speech transcript, streamed as pure ASR (no slides). This is the §2.2
// "off-deck" path: there is no deck to read titles from, so the chapter skeleton
// must be DERIVED from the speech itself (see narration.js) — titles appear only
// after the system has "listened" for a while, then refine / split on topic shifts.
//
// Source: 蔡元培《就任北京大学校长之演说》(1917), 公有领域. zh.wikisource.org
// Chosen because it's a real oral address with an explicit three-part structure
// (一曰抱定宗旨 / 二曰砥礪德行 / 三曰敬愛師友) — a clean test for segmentation.

export const TRANSCRIPT = {
  title: '蔡元培《就任北京大学校长之演说》· 真实文稿（纯语音）',
  source: '蔡元培 1917 · zh.wikisource.org（公有领域）',
  utterances: [
    // 开场
    '五年前，嚴幾道先生爲本校校長時，予擔任教授，開學日，曾有所貢獻於同校。',
    '諸君多自預科畢業而來，想必聞知，士別三日，刮目相見，況時閱數載，諸君較昔，當必爲長足之進步矣。',
    '予今長斯校，請更以三事爲諸君告。',
    // 一曰抱定宗旨
    '一曰抱定宗旨。',
    '諸君來此求學，必有一定宗旨，欲求宗旨之正大與否，必先知大學之性質。',
    '今人肄習專門學校，學成任事，此固勢所必然，而在大學則不然。',
    '大學者，研究高深學問者也。',
    '外人每指摘本校之腐敗，以求學於此者，皆有做官發財思想，故畢業預科者，多入法科，入文科者甚少，蓋以法科爲干祿之終南捷徑也。',
    '因做官心熱，對於教員，則不問其學問之淺深，惟問其官階之大小。',
    '究之外人指摘之當否，姑不具論，然弭謗莫如自修，人譏我腐敗，而我不腐敗，問心無愧，於我何傷？',
    '所以諸君須抱定宗旨，爲求學而來。入法科者，非爲做官；入商科者，非爲致富。',
    '宗旨既定，自趨正軌。苟徒志在做官發財，宗旨既乖，趨向自異。',
    '平時則放蕩冶遊，考試則熟讀講義，不思學問之有無，惟爭分數之優劣。',
    '敷衍三四年，潦草塞責，文憑到手，卽可藉此活動於社會，豈非與求學初衷大相背馳乎？',
    '今諸君苟不於此時植其基，勤其學，則將來出而任事，擔任講席，則必貽誤學生，置身政界，則必貽誤國家，是誤人也。',
    '誤己誤人，又豈本心所願乎？此余所希望於諸君者一也。',
    // 二曰砥礪德行
    '二曰砥礪德行。',
    '方今風俗日偷，道德淪喪，北京社會，尤爲惡劣，敗德毀行之事，觸目皆是。',
    '非根基深固，鮮不爲流俗所染。諸君肄業大學，當能束身自愛。',
    '然國家之興替，視風俗之厚薄，流俗如此，前途何堪設想！',
    '故必有卓絕之士，以身作則，力矯頹俗。諸君爲大學學生，地位甚高，肩此重任，責無旁貸。',
    '故諸君不惟思所以感己，更必有以勵人。苟德之不修，學之不講，己且爲人輕侮，更何足以感人？',
    '爲諸君計，莫如以正當之娛樂，易不正當之娛樂，庶於道德無虧，而身體有益。',
    '此余所希望於諸君者二也。',
    // 三曰敬愛師友
    '三曰敬愛師友。',
    '教員口講指畫，職員供應職務，皆以圖諸君求學便利，自應以誠相待，敬禮有加。',
    '至於同學共處一堂，尤應互相親愛，庶可收切磋之效，不惟開誠布公，更宜道義相勗。',
    '余在德國，每至店肆購買物品，店主殷勤款待，付價接物，互相稱謝，此雖小節，然亦交際所必需。',
    '常人如此，況堂堂大學生乎？此余所希望於諸君者三也。',
    // 计画二事
    '余到校視事僅數日，校事多未詳悉，茲所計畫者二事：一曰改良講義。',
    '以後講義，祗列綱要，細微末節，或講師口授，或自行參考，以期學有心得，能裨實用。',
    '二曰添購書籍。本校圖書館書籍雖多，新出者甚少，刻擬籌集款項，多購新書。',
    '今日所與諸君陳說者只此，以後會晤日長，隨時再爲商榷可也。',
  ],
};

export function runTranscript(emit, { speed = 2.5 } = {}) {
  const timers = [];
  const at = (d, fn) => timers.push(setTimeout(fn, Math.max(0, d)));
  const S = (ms) => ms / speed;
  let t = 600;

  // session title only — NO slide.change. Pure speech.
  at(200, () => emit({ type: 'session.config', title: TRANSCRIPT.title }));

  for (const text of TRANSCRIPT.utterances) {
    const dur = Math.min(7000, Math.max(1500, text.length * 130));
    const startAt = t;
    const steps = 3;
    for (let i = 1; i <= steps; i++) {
      const ratio = i / (steps + 1);
      const prefix = text.slice(0, Math.max(2, Math.round(text.length * ratio)));
      at(startAt + S(dur * ratio), () => emit({ type: 'asr.interim', text: prefix }));
    }
    at(startAt + S(dur), () =>
      emit({ type: 'asr.segment', text, t_start: Date.now() - 1000, t_end: Date.now() })
    );
    t = startAt + S(dur) + S(450);
  }

  return {
    durationMs: t + 2000,
    stop() {
      for (const id of timers) clearTimeout(id);
      timers.length = 0;
    },
  };
}
