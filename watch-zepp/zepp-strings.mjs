#!/usr/bin/env node
// Writes the Zepp OS watch app's words in every language the app speaks:
//   lib/strings.js          the watch's own (the app's language, which the phone sends)
//   setting/i18n/*.po       the settings page inside the Zepp phone app (the phone's language)
//   page/i18n/*.po          one word per watch language: which of ours it is, before the phone said
// The watch says what the Wear OS watch says, so its words come from there
// (frontend/android/wear/src/main/res/values*/strings.xml, written by wear-strings.mjs from the
// app's own locale packs and the Apple Watch's strings); the few only this watch says are below.
// Run it after changing any of them, and commit what it writes:
//
//   node watch-zepp/zepp-strings.mjs
//
// Copy tone (CONTRIBUTING.md): plain, human, a bit witty, never an em dash.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wearRes = join(here, '..', 'frontend', 'android', 'wear', 'src', 'main', 'res')

// the app's language → [Wear OS values folder, Zepp locale]
export const LANGS = {
  en: ['values', 'en-US'], de: ['values-de', 'de-DE'], fr: ['values-fr', 'fr-FR'], es: ['values-es', 'es-ES'],
  it: ['values-it', 'it-IT'], pt: ['values-pt', 'pt-PT'], 'pt-BR': ['values-pt-rBR', 'pt-BR'], pl: ['values-pl', 'pl-PL'],
  hu: ['values-hu', 'hu-HU'], tr: ['values-tr', 'tr-TR'], ru: ['values-ru', 'ru-RU'], uk: ['values-uk', 'uk-UA'],
  ar: ['values-ar', 'ar-EG'], hi: ['values-hi', 'hi-IN'], bn: ['values-bn', 'bn-BD'], th: ['values-th', 'th-TH'],
  ko: ['values-ko', 'ko-KR'], sv: ['values-sv', 'sv-SE'], zh: ['values-zh', 'zh-CN'], 'zh-TW': ['values-zh-rTW', 'zh-TW'],
  // The app speaks 25 languages plus English; these six were left out of the map above, so the
  // watch fell back to English for them even though wear-strings.mjs had already written their
  // values folder (116 strings each). Idiomatic codes, same pattern as the rest.
  cs: ['values-cs', 'cs-CZ'], da: ['values-da', 'da-DK'], fa: ['values-fa', 'fa-IR'],
  id: ['values-id', 'id-ID'], lt: ['values-lt', 'lt-LT'], vi: ['values-vi', 'vi-VN'],
}

// Only this watch says these: on the watch...
const OWN = {
  not_paired: {
    en: 'Pair me first: Zepp app, gymbro, Settings.', de: 'Erst koppeln: Zepp-App, gymbro, Einstellungen.',
    fr: 'Associe-moi d’abord : app Zepp, gymbro, Réglages.', es: 'Vincúlame primero: app Zepp, gymbro, Ajustes.',
    it: 'Prima abbinami: app Zepp, gymbro, Impostazioni.', pt: 'Emparelha-me primeiro: app Zepp, gymbro, Definições.',
    'pt-BR': 'Pareie primeiro: app Zepp, gymbro, Configurações.', pl: 'Najpierw sparuj: aplikacja Zepp, gymbro, Ustawienia.',
    hu: 'Előbb párosíts: Zepp app, gymbro, Beállítások.', tr: 'Önce eşle: Zepp uygulaması, gymbro, Ayarlar.',
    ru: 'Сначала подключите: приложение Zepp, gymbro, Настройки.', uk: 'Спершу під’єднай: застосунок Zepp, gymbro, Налаштування.',
    ar: 'اربطني أولًا: تطبيق Zepp، ثم gymbro، ثم الإعدادات.', hi: 'पहले जोड़ें: Zepp ऐप, gymbro, सेटिंग।',
    bn: 'আগে যুক্ত করুন: Zepp অ্যাপ, gymbro, সেটিংস।', th: 'จับคู่ก่อน: แอป Zepp, gymbro, การตั้งค่า',
    ko: '먼저 페어링하세요: Zepp 앱, gymbro, 설정.', sv: 'Parkoppla mig först: Zepp-appen, gymbro, Inställningar.',
    zh: '请先配对：Zepp App，gymbro，设置。', 'zh-TW': '請先配對：Zepp App，gymbro，設定。',
    cs: 'Nejdřív mě spáruj: aplikace Zepp, gymbro, Nastavení.', da: 'Par mig først: Zepp-appen, gymbro, Indstillinger.', fa: 'اول من را جفت کن: برنامه Zepp، gymbro، تنظیمات.', id: 'Saya dulu yang dipasangkan: aplikasi Zepp, gymbro, Pengaturan.', lt: 'Pirmiausia susiek mane: „Zepp“ programa, gymbro, Nustatymai.', vi: 'Ghép tôi trước đã: ứng dụng Zepp, gymbro, Cài đặt.'
  },
  syncing: {
    en: 'Checking in with your server…', de: 'Frage deinen Server…', fr: 'Je demande à ton serveur…', es: 'Preguntando a tu servidor…',
    it: 'Chiedo al tuo server…', pt: 'A perguntar ao teu servidor…', 'pt-BR': 'Perguntando ao seu servidor…', pl: 'Pytam twój serwer…',
    hu: 'Megkérdezem a szervered…', tr: 'Sunucuna soruluyor…', ru: 'Спрашиваю ваш сервер…', uk: 'Питаю твій сервер…',
    ar: 'أسأل خادمك…', hi: 'आपके सर्वर से पूछ रहे हैं…', bn: 'আপনার সার্ভারকে জিজ্ঞেস করছি…', th: 'กำลังถามเซิร์ฟเวอร์ของคุณ…',
    ko: '서버에 물어보는 중…', sv: 'Frågar din server…', zh: '正在询问你的服务器…', 'zh-TW': '正在詢問你的伺服器…',
    cs: 'Ozývám se tvému serveru…', da: 'Tjekker ind hos din server…', fa: 'در حال برقراری ارتباط با سرور شما…', id: 'Menyapa server Anda…', lt: 'Tikrinu savo serverį…', vi: 'Đang liên hệ với máy chủ của bạn…'
  },
  discard_confirm: {
    en: 'Tap again to discard', de: 'Nochmal tippen zum Verwerfen', fr: 'Touche encore pour abandonner', es: 'Toca otra vez para descartar',
    it: 'Tocca ancora per scartare', pt: 'Toca outra vez para descartar', 'pt-BR': 'Toque de novo para descartar', pl: 'Stuknij ponownie, by odrzucić',
    hu: 'Koppints újra az elvetéshez', tr: 'Atmak için tekrar dokun', ru: 'Нажмите ещё раз, чтобы удалить', uk: 'Торкнись ще раз, щоб скасувати',
    ar: 'انقر مرة أخرى للتجاهل', hi: 'हटाने के लिए फिर टैप करें', bn: 'বাতিল করতে আবার ট্যাপ করুন', th: 'แตะอีกครั้งเพื่อทิ้ง',
    ko: '한 번 더 누르면 삭제돼요', sv: 'Tryck igen för att slänga', zh: '再点一次即放弃', 'zh-TW': '再點一次即放棄',
    cs: 'Klepnutím znovu zrušíš', da: 'Tryk igen for at kassere', fa: 'برای نادیده گرفتن دوباره بزنید', id: 'Ketuk lagi untuk membuang', lt: 'Bakstelėkite dar kartą, kad atmestumėte', vi: 'Chạm lần nữa để bỏ'
  },
}

// ...and on the settings page in the Zepp phone app.
const SETTING = {
  server: {
    en: 'Server address', de: 'Serveradresse', fr: 'Adresse du serveur', es: 'Dirección del servidor', it: 'Indirizzo del server',
    pt: 'Endereço do servidor', 'pt-BR': 'Endereço do servidor', pl: 'Adres serwera', hu: 'Szervercím', tr: 'Sunucu adresi',
    ru: 'Адрес сервера', uk: 'Адреса сервера', ar: 'عنوان الخادم', hi: 'सर्वर का पता', bn: 'সার্ভারের ঠিকানা', th: 'ที่อยู่เซิร์ฟเวอร์',
    ko: '서버 주소', sv: 'Serveradress', zh: '服务器地址', 'zh-TW': '伺服器位址',
    cs: 'Adresa serveru', da: 'Serveradresse', fa: 'آدرس سرور', id: 'Alamat server', lt: 'Serverio adresas', vi: 'Địa chỉ máy chủ'
  },
  code: {
    en: 'Pairing code', de: 'Kopplungscode', fr: 'Code d’association', es: 'Código de vinculación', it: 'Codice di abbinamento',
    pt: 'Código de emparelhamento', 'pt-BR': 'Código de pareamento', pl: 'Kod parowania', hu: 'Párosítókód', tr: 'Eşleme kodu',
    ru: 'Код подключения', uk: 'Код під’єднання', ar: 'رمز الربط', hi: 'जोड़ने का कोड', bn: 'যুক্ত করার কোড', th: 'รหัสจับคู่',
    ko: '페어링 코드', sv: 'Parkopplingskod', zh: '配对码', 'zh-TW': '配對碼',
    cs: 'Kód párování', da: 'Pairingskode', fa: 'کد جفت‌سازی', id: 'Kode pemasangan', lt: 'Susiejimo kodas', vi: 'Mã ghép nối'
  },
  how: {
    en: 'In gymbro, open Settings, Zepp OS watch, Pair a watch, and type the address and code it shows here.',
    de: 'Öffne in gymbro Einstellungen, Zepp-OS-Uhr, Uhr koppeln, und tippe Adresse und Code hier ein.',
    fr: 'Dans gymbro, ouvre Réglages, Montre Zepp OS, Associer une montre, et saisis ici l’adresse et le code affichés.',
    es: 'En gymbro, abre Ajustes, Reloj Zepp OS, Vincular un reloj, y escribe aquí la dirección y el código que aparecen.',
    it: 'In gymbro apri Impostazioni, Orologio Zepp OS, Abbina un orologio, e inserisci qui indirizzo e codice.',
    pt: 'No gymbro, abre Definições, Relógio Zepp OS, Emparelhar um relógio, e escreve aqui o endereço e o código.',
    'pt-BR': 'No gymbro, abra Configurações, Relógio Zepp OS, Parear um relógio, e digite aqui o endereço e o código.',
    pl: 'W gymbro otwórz Ustawienia, Zegarek Zepp OS, Sparuj zegarek, i wpisz tutaj adres i kod.',
    hu: 'A gymbroban nyisd meg: Beállítások, Zepp OS óra, Óra párosítása, és írd be ide a címet és a kódot.',
    tr: 'gymbro’de Ayarlar, Zepp OS saat, Saat eşle’yi aç ve gösterilen adresi ve kodu buraya yaz.',
    ru: 'В gymbro откройте Настройки, Часы на Zepp OS, Подключить часы, и введите здесь адрес и код.',
    uk: 'В gymbro відкрий Налаштування, Годинник на Zepp OS, Під’єднати годинник, і введи тут адресу та код.',
    ar: 'في gymbro افتح الإعدادات، ثم ساعة Zepp OS، ثم ربط ساعة، واكتب هنا العنوان والرمز الظاهرين.',
    hi: 'gymbro में सेटिंग, Zepp OS घड़ी, घड़ी जोड़ें खोलें, और दिखाया गया पता और कोड यहाँ लिखें।',
    bn: 'gymbro-এ সেটিংস, Zepp OS ঘড়ি, ঘড়ি যুক্ত করুন খুলুন, এবং দেখানো ঠিকানা ও কোড এখানে লিখুন।',
    th: 'ใน gymbro เปิดการตั้งค่า, นาฬิกา Zepp OS, จับคู่นาฬิกา แล้วพิมพ์ที่อยู่และรหัสที่แสดงที่นี่',
    ko: 'gymbro에서 설정, Zepp OS 워치, 워치 페어링을 열고 표시된 주소와 코드를 여기에 입력하세요.',
    sv: 'Öppna Inställningar, Zepp OS-klocka, Parkoppla en klocka i gymbro och skriv in adressen och koden här.',
    zh: '在 gymbro 里打开设置、Zepp OS 手表、配对手表，把显示的地址和配对码填在这里。',
    'zh-TW': '在 gymbro 裡打開設定、Zepp OS 手錶、配對手錶，把顯示的位址和配對碼填在這裡。',
    cs: 'V gymbro otevři Nastavení, hodinky Zepp OS, Spárovat hodinky a sem napiš adresu a kód, které ukazuje.', da: 'I gymbro åbn Indstillinger, Zepp OS-ur, Par et ur, og skriv adressen og koden, den viser, her.', fa: 'در gymbro، تنظیمات، ساعت Zepp OS، جفت کردن ساعت را باز کنید و آدرس و کدی را که نشان می‌دهد اینجا بنویسید.', id: 'Buka gymbro, Pengaturan, jam Zepp OS, Pasangkan jam, lalu ketik alamat dan kode yang ditampilkan di sini.', lt: 'Atidarykite gymbro nustatymus, „Zepp OS“ laikrodį, Susieti laikrodį ir įrašykite čia rodomą adresą bei kodą.', vi: 'Trong gymbro, mở Cài đặt, đồng hồ Zepp OS, Ghép nối đồng hồ, rồi nhập địa chỉ và mã hiển thị ở đây.'
  },
  pair: {
    en: 'Pair', de: 'Koppeln', fr: 'Associer', es: 'Vincular', it: 'Abbina', pt: 'Emparelhar', 'pt-BR': 'Parear', pl: 'Sparuj',
    hu: 'Párosítás', tr: 'Eşle', ru: 'Подключить', uk: 'Під’єднати', ar: 'ربط', hi: 'जोड़ें', bn: 'যুক্ত করুন', th: 'จับคู่',
    ko: '페어링', sv: 'Parkoppla', zh: '配对', 'zh-TW': '配對',
    cs: 'Spárovat', da: 'Par', fa: 'جفت کردن', id: 'Pasangkan', lt: 'Susieti', vi: 'Ghép nối'
  },
  pairing: {
    en: 'Pairing…', de: 'Kopple…', fr: 'Association…', es: 'Vinculando…', it: 'Abbinamento…', pt: 'A emparelhar…', 'pt-BR': 'Pareando…',
    pl: 'Paruję…', hu: 'Párosítás…', tr: 'Eşleniyor…', ru: 'Подключаю…', uk: 'Під’єдную…', ar: 'جارٍ الربط…', hi: 'जोड़ रहे हैं…',
    bn: 'যুক্ত করা হচ্ছে…', th: 'กำลังจับคู่…', ko: '페어링 중…', sv: 'Parkopplar…', zh: '正在配对…', 'zh-TW': '正在配對…',
    cs: 'Párování…', da: 'Parer…', fa: 'در حال جفت‌سازی…', id: 'Memasangkan…', lt: 'Siejiama…', vi: 'Đang ghép nối…'
  },
  paired: {
    en: 'Paired with {0}. Open gymbro on your watch.', de: 'Gekoppelt mit {0}. Öffne gymbro auf der Uhr.',
    fr: 'Associée à {0}. Ouvre gymbro sur ta montre.', es: 'Vinculado con {0}. Abre gymbro en tu reloj.',
    it: 'Abbinato a {0}. Apri gymbro sull’orologio.', pt: 'Emparelhado com {0}. Abre o gymbro no relógio.',
    'pt-BR': 'Pareado com {0}. Abra o gymbro no relógio.', pl: 'Sparowano z {0}. Otwórz gymbro na zegarku.',
    hu: 'Párosítva: {0}. Nyisd meg a gymbrot az órán.', tr: '{0} ile eşlendi. Saatinde gymbro’i aç.',
    ru: 'Подключено к {0}. Откройте gymbro на часах.', uk: 'Під’єднано до {0}. Відкрий gymbro на годиннику.',
    ar: 'تم الربط مع {0}. افتح gymbro على ساعتك.', hi: '{0} से जुड़ गया। घड़ी पर gymbro खोलें।',
    bn: '{0}-এর সাথে যুক্ত হয়েছে। ঘড়িতে gymbro খুলুন।', th: 'จับคู่กับ {0} แล้ว เปิด gymbro บนนาฬิกาได้เลย',
    ko: '{0}와(과) 페어링됐어요. 워치에서 gymbro을 여세요.', sv: 'Parkopplad med {0}. Öppna gymbro på klockan.',
    zh: '已与 {0} 配对。在手表上打开 gymbro 吧。', 'zh-TW': '已與 {0} 配對。在手錶上打開 gymbro 吧。',
    cs: 'Spárováno s {0}. Otevři gymbro na hodinkách.', da: 'Parret med {0}. Åbn gymbro på dit ur.', fa: 'با {0} جفت شد. gymbro را در ساعت خود باز کنید.', id: 'Terpasang dengan {0}. Buka gymbro di jam Anda.', lt: 'Susietas su {0}. Atidarykite gymbro laikrodyje.', vi: 'Đã ghép với {0}. Mở gymbro trên đồng hồ của bạn.'
  },
  failed: {
    en: 'That didn’t work. Check the address and the code, a code lasts ten minutes.',
    de: 'Hat nicht geklappt. Prüf Adresse und Code, ein Code gilt zehn Minuten.',
    fr: 'Ça n’a pas marché. Vérifie l’adresse et le code, un code dure dix minutes.',
    es: 'No ha funcionado. Revisa la dirección y el código, un código dura diez minutos.',
    it: 'Non ha funzionato. Controlla indirizzo e codice, un codice dura dieci minuti.',
    pt: 'Não resultou. Verifica o endereço e o código, um código dura dez minutos.',
    'pt-BR': 'Não deu certo. Confira o endereço e o código, um código vale por dez minutos.',
    pl: 'Nie wyszło. Sprawdź adres i kod, kod działa dziesięć minut.',
    hu: 'Nem sikerült. Nézd meg a címet és a kódot, egy kód tíz percig él.',
    tr: 'Olmadı. Adresi ve kodu kontrol et, bir kod on dakika geçerli.',
    ru: 'Не вышло. Проверьте адрес и код, код действует десять минут.',
    uk: 'Не вийшло. Перевір адресу й код, код діє десять хвилин.',
    ar: 'لم ينجح ذلك. تحقق من العنوان والرمز، فالرمز صالح لعشر دقائق.',
    hi: 'नहीं हुआ। पता और कोड जाँचें, कोड दस मिनट चलता है।',
    bn: 'হয়নি। ঠিকানা ও কোড দেখুন, একটি কোড দশ মিনিট চলে।',
    th: 'ไม่สำเร็จ ตรวจที่อยู่และรหัสอีกครั้ง รหัสใช้ได้สิบนาที',
    ko: '안 됐어요. 주소와 코드를 확인하세요. 코드는 10분 동안 유효해요.',
    sv: 'Det gick inte. Kolla adressen och koden, en kod gäller i tio minuter.',
    zh: '没成功。检查一下地址和配对码，配对码十分钟内有效。', 'zh-TW': '沒成功。檢查一下位址和配對碼，配對碼十分鐘內有效。',
    cs: 'To nevyšlo. Zkontroluj adresu a kód, kód platí deset minut.', da: 'Det virkede ikke. Tjek adressen og koden, en kode gælder ti minutter.', fa: 'جواب نداد. آدرس و کد را بررسی کنید، کد ده دقیقه معتبر است.', id: 'Itu tidak berhasil. Periksa alamat dan kodenya, kode berlaku sepuluh menit.', lt: 'Nepavyko. Patikrinkite adresą ir kodą, kodas galioja dešimt minučių.', vi: 'Không được. Kiểm tra địa chỉ và mã, mã có hiệu lực mười phút.'
  },
  unpair: {
    en: 'Unpair', de: 'Entkoppeln', fr: 'Dissocier', es: 'Desvincular', it: 'Disabbina', pt: 'Desemparelhar', 'pt-BR': 'Desparear',
    pl: 'Rozłącz', hu: 'Párosítás bontása', tr: 'Eşlemeyi kaldır', ru: 'Отключить', uk: 'Від’єднати', ar: 'إلغاء الربط',
    hi: 'अलग करें', bn: 'বিচ্ছিন্ন করুন', th: 'เลิกจับคู่', ko: '페어링 해제', sv: 'Koppla från', zh: '取消配对', 'zh-TW': '取消配對',
    cs: 'Odpojit', da: 'Afbryd par', fa: 'قطع جفت', id: 'Lepaskan', lt: 'Atsieiti', vi: 'Bỏ ghép'
  },
  not_paired_yet: {
    en: 'Not paired yet.', de: 'Noch nicht gekoppelt.', fr: 'Pas encore associée.', es: 'Aún sin vincular.', it: 'Non ancora abbinato.',
    pt: 'Ainda não emparelhado.', 'pt-BR': 'Ainda não pareado.', pl: 'Jeszcze nie sparowano.', hu: 'Még nincs párosítva.',
    tr: 'Henüz eşlenmedi.', ru: 'Ещё не подключено.', uk: 'Ще не під’єднано.', ar: 'لم يتم الربط بعد.', hi: 'अभी जुड़ा नहीं है।',
    bn: 'এখনও যুক্ত হয়নি।', th: 'ยังไม่ได้จับคู่', ko: '아직 페어링되지 않았어요.', sv: 'Inte parkopplad än.', zh: '还没有配对。', 'zh-TW': '還沒有配對。',
    cs: 'Zatím nespárováno.', da: 'Endnu ikke parret.', fa: 'هنوز جفت نشده است.', id: 'Belum terpasang.', lt: 'Dar nesusieta.', vi: 'Chưa ghép nối.'
  },
}

// Android's escaping undone, its numbered placeholders as ours ("%2$d" → "{1}").
function unescapeRes (s) {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\@/g, '@').replace(/\\\?/g, '?').replace(/\\\\/g, '\\')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/%(\d+)\$[sd]/g, (_, n) => '{' + (Number(n) - 1) + '}')
}
export function readWear (folder) {
  const file = join(wearRes, folder, 'strings.xml')
  if (!existsSync(file)) throw new Error('missing ' + file + ': run frontend/android/wear/wear-strings.mjs first')
  const out = {}
  for (const m of readFileSync(file, 'utf8').matchAll(/<string name="([a-z_]+)">([\s\S]*?)<\/string>/g)) out[m[1]] = unescapeRes(m[2])
  return out
}

const NO_DASH = /—/
function check (lang, name, value) {
  if (typeof value !== 'string' || !value) throw new Error(`${lang}: ${name} is missing`)
  if (NO_DASH.test(value)) throw new Error(`${lang}: ${name} has an em dash: ${value}`)
}
// gettext's .po quoting
const po = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'

export function build () {
  const watch = {}
  const settings = {}
  for (const [lang, [folder]] of Object.entries(LANGS)) {
    const w = readWear(folder)
    delete w.app_name; delete w.tile_desc; delete w.complication_desc; delete w.notif_running; delete w.hr_why
    for (const [k, tr] of Object.entries(OWN)) w[k] = tr[lang]
    for (const [k, v] of Object.entries(w)) check(lang, k, v)
    watch[lang] = w
    const st = {}
    for (const [k, tr] of Object.entries(SETTING)) { check(lang, k, tr[lang]); st[k] = tr[lang] }
    settings[lang] = st
  }
  // every language has every word English has
  for (const [lang, w] of Object.entries(watch)) for (const k of Object.keys(watch.en)) check(lang, k, w[k])
  return { watch, settings }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { watch, settings } = build()
  const head = '// The Zepp OS watch\'s words. Written by watch-zepp/zepp-strings.mjs: change that, not this.\n'
  writeFileSync(join(here, 'lib', 'strings.js'), head + 'export const STRINGS = ' + JSON.stringify(watch, null, 1) + '\n')
  for (const dir of ['setting/i18n', 'page/i18n']) mkdirSync(join(here, dir), { recursive: true })
  for (const [lang, [, locale]] of Object.entries(LANGS)) {
    const st = settings[lang]
    writeFileSync(join(here, 'setting', 'i18n', locale + '.po'),
      Object.entries(st).map(([k, v]) => `msgid ${po(k)}\nmsgstr ${po(v)}\n`).join('\n'))
    // The watch's own language, as one of ours, until the phone says which the app speaks.
    writeFileSync(join(here, 'page', 'i18n', locale + '.po'), `msgid "lang"\nmsgstr ${po(lang)}\n\nmsgid "appName"\nmsgstr "gymbro"\n`)
  }
  console.log('wrote lib/strings.js, setting/i18n and page/i18n for', Object.keys(LANGS).length, 'languages')
}
