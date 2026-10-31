/**
 * Injects the Phase 3 "Reports" ad-dashboard keys into ALL 20 locale
 * dictionaries (same pattern as the earlier ads i18n codegen scripts).
 *
 * Anchor: the existing `tabCampaigns:` line inside the `ads` namespace —
 * the block is inserted right after it with identical indentation.
 *
 * Afterwards it verifies every dictionary carries all 17 new keys.
 *
 * Run: bun scripts/ui18n-codegen/inject-ads-phase3.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The 17 Phase 3 keys per locale. `—` is the em dash (U+2014). */
const PAYLOADS: Record<string, Record<string, string>> = {
  en: {
    tabReports: 'Reports',
    reportsTitle: 'Campaign performance',
    reportsHint:
      'Live metrics from the event pipeline. An impression counts as viewable once the ad has been at least 50% visible for one continuous second in an active tab.',
    reportsEmpty: 'No campaigns yet — create one and its statistics will appear here.',
    reportsLoading: 'Loading statistics…',
    downloadCsv: 'Download CSV',
    csvNote:
      'The CSV export is formula-safe: cells beginning with =, +, - or @ are neutralised, and metrics without data export as an em dash (—).',
    colCampaign: 'Campaign',
    colBilling: 'Billing',
    colImpressions: 'Impressions',
    colViewable: 'Viewable impressions',
    colClicks: 'Clicks',
    colCtr: 'CTR',
    colSpent: 'Spent',
    colEcpc: 'eCPC',
  },
  ru: {
    tabReports: 'Отчёты',
    reportsTitle: 'Эффективность кампаний',
    reportsHint:
      'Живые метрики из конвейера событий. Показ засчитывается как видимый, после того как объявление видно не менее 50% площади одну непрерывную секунду в активной вкладке.',
    reportsEmpty: 'Кампаний пока нет — создайте первую, и её статистика появится здесь.',
    reportsLoading: 'Загрузка статистики…',
    downloadCsv: 'Скачать CSV',
    csvNote:
      'CSV-экспорт защищён от формул: ячейки, начинающиеся с =, +, - или @, нейтрализуются, а метрики без данных экспортируются как длинное тире (—).',
    colCampaign: 'Кампания',
    colBilling: 'Модель',
    colImpressions: 'Показы',
    colViewable: 'Видимые показы',
    colClicks: 'Клики',
    colCtr: 'CTR',
    colSpent: 'Расход',
    colEcpc: 'eCPC',
  },
  uk: {
    tabReports: 'Звіти',
    reportsTitle: 'Ефективність кампаній',
    reportsHint:
      'Живі метрики з конвеєра подій. Показ зараховується як видимий, після того як оголошення видно не менше 50% площі одну безперервну секунду в активній вкладці.',
    reportsEmpty: 'Кампаній ще немає — створіть першу, і її статистика з’явиться тут.',
    reportsLoading: 'Завантаження статистики…',
    downloadCsv: 'Завантажити CSV',
    csvNote:
      'CSV-експорт захищений від формул: комірки, що починаються з =, +, - або @, нейтралізуються, а метрики без даних експортуються як довге тире (—).',
    colCampaign: 'Кампанія',
    colBilling: 'Модель',
    colImpressions: 'Покази',
    colViewable: 'Видимі покази',
    colClicks: 'Кліки',
    colCtr: 'CTR',
    colSpent: 'Витрати',
    colEcpc: 'eCPC',
  },
  de: {
    tabReports: 'Berichte',
    reportsTitle: 'Kampagnenleistung',
    reportsHint:
      'Live-Metriken aus der Ereignis-Pipeline. Eine Impression zählt als sichtbar, sobald die Anzeige mindestens 50% Fläche eine durchgehende Sekunde lang in einem aktiven Tab sichtbar ist.',
    reportsEmpty: 'Noch keine Kampagnen — lege eine an, dann erscheinen hier ihre Statistiken.',
    reportsLoading: 'Statistiken werden geladen…',
    downloadCsv: 'CSV herunterladen',
    csvNote:
      'Der CSV-Export ist formelsicher: Zellen, die mit =, +, - oder @ beginnen, werden neutralisiert, und Metriken ohne Daten werden als Gedankenstrich (—) exportiert.',
    colCampaign: 'Kampagne',
    colBilling: 'Abrechnung',
    colImpressions: 'Impressionen',
    colViewable: 'Sichtbare Impressionen',
    colClicks: 'Klicks',
    colCtr: 'CTR',
    colSpent: 'Ausgegeben',
    colEcpc: 'eCPC',
  },
  es: {
    tabReports: 'Informes',
    reportsTitle: 'Rendimiento de campañas',
    reportsHint:
      'Métricas en vivo del canal de eventos. Una impresión cuenta como visible cuando el anuncio está al menos un 50% visible durante un segundo continuo en una pestaña activa.',
    reportsEmpty: 'Aún no hay campañas: crea una y sus estadísticas aparecerán aquí.',
    reportsLoading: 'Cargando estadísticas…',
    downloadCsv: 'Descargar CSV',
    csvNote:
      'La exportación CSV es segura frente a fórmulas: las celdas que empiezan por =, +, - o @ se neutralizan, y las métricas sin datos se exportan como raya (—).',
    colCampaign: 'Campaña',
    colBilling: 'Facturación',
    colImpressions: 'Impresiones',
    colViewable: 'Impresiones visibles',
    colClicks: 'Clics',
    colCtr: 'CTR',
    colSpent: 'Gasto',
    colEcpc: 'eCPC',
  },
  pt: {
    tabReports: 'Relatórios',
    reportsTitle: 'Desempenho das campanhas',
    reportsHint:
      'Métricas ao vivo do pipeline de eventos. Uma impressão conta como visível quando o anúncio está pelo menos 50% visível durante um segundo contínuo num separador ativo.',
    reportsEmpty: 'Ainda não há campanhas — crie uma e as suas estatísticas aparecerão aqui.',
    reportsLoading: 'A carregar estatísticas…',
    downloadCsv: 'Descarregar CSV',
    csvNote:
      'A exportação CSV é segura contra fórmulas: células que começam por =, +, - ou @ são neutralizadas, e métricas sem dados são exportadas como travessão (—).',
    colCampaign: 'Campanha',
    colBilling: 'Faturação',
    colImpressions: 'Impressões',
    colViewable: 'Impressões visíveis',
    colClicks: 'Cliques',
    colCtr: 'CTR',
    colSpent: 'Gasto',
    colEcpc: 'eCPC',
  },
  fr: {
    tabReports: 'Rapports',
    reportsTitle: 'Performance des campagnes',
    reportsHint:
      'Des métriques en direct du pipeline d’événements. Une impression est comptée visible lorsque l’annonce est visible à au moins 50% pendant une seconde continue dans un onglet actif.',
    reportsEmpty: 'Pas encore de campagne — créez-en une et ses statistiques apparaîtront ici.',
    reportsLoading: 'Chargement des statistiques…',
    downloadCsv: 'Télécharger le CSV',
    csvNote:
      'L’export CSV est protégé contre les formules : les cellules commençant par =, +, - ou @ sont neutralisées, et les métriques sans donnée sont exportées comme un tiret cadratin (—).',
    colCampaign: 'Campagne',
    colBilling: 'Facturation',
    colImpressions: 'Impressions',
    colViewable: 'Impressions visibles',
    colClicks: 'Clics',
    colCtr: 'CTR',
    colSpent: 'Dépensé',
    colEcpc: 'eCPC',
  },
  hi: {
    tabReports: 'रिपोर्ट',
    reportsTitle: 'कैंपेन प्रदर्शन',
    reportsHint:
      'इवेंट पाइपलाइन से लाइव मेट्रिक्स। विज्ञापन तब व्यूएबल इंप्रेशन गिना जाता है जब वह सक्रिय टैब में लगातार एक सेकंड तक कम से कम 50% दिखाई दे।',
    reportsEmpty: 'अभी कोई कैंपेन नहीं है — एक बनाएँ और उसके आँकड़े यहाँ दिखेंगे।',
    reportsLoading: 'आँकड़े लोड हो रहे हैं…',
    downloadCsv: 'CSV डाउनलोड करें',
    csvNote:
      'CSV निर्यात फ़ॉर्मूला-सुरक्षित है: =, +, - या @ से शुरू होने वाली सेल निष्क्रिय कर दी जाती हैं, और बिना डेटा वाली मेट्रिक्स डैश (—) के रूप में निर्यात होती हैं।',
    colCampaign: 'कैंपेन',
    colBilling: 'बिलिंग',
    colImpressions: 'इंप्रेशन',
    colViewable: 'व्यूएबल इंप्रेशन',
    colClicks: 'क्लिक',
    colCtr: 'CTR',
    colSpent: 'खर्च',
    colEcpc: 'eCPC',
  },
  bn: {
    tabReports: 'রিপোর্ট',
    reportsTitle: 'ক্যাম্পেইন পারফরম্যান্স',
    reportsHint:
      'ইভেন্ট পাইপলাইন থেকে লাইভ মেট্রিক্স। অ্যাক্টিভ ট্যাবে অন্তত ৫০% দৃশ্যমান থাকলে একটানা এক সেকেন্ড পর ইম্প্রেশন ভিউএবল গণ্য হয়।',
    reportsEmpty: 'এখনও কোনো ক্যাম্পেইন নেই — একটি তৈরি করুন, তার পরিসংখ্যান এখানে দেখা যাবে।',
    reportsLoading: 'পরিসংখ্যান লোড হচ্ছে…',
    downloadCsv: 'CSV ডাউনলোড',
    csvNote:
      'CSV এক্সপোর্ট ফর্মুলা-নিরাপদ: =, +, - বা @ দিয়ে শুরু হওয়া সেল নিরপেক্ষ করা হয়, আর ডেটাহীন মেট্রিক্স ড্যাশ (—) হিসেবে এক্সপোর্ট হয়।',
    colCampaign: 'ক্যাম্পেইন',
    colBilling: 'বিলিং',
    colImpressions: 'ইম্প্রেশন',
    colViewable: 'ভিউএবল ইম্প্রেশন',
    colClicks: 'ক্লিক',
    colCtr: 'CTR',
    colSpent: 'খরচ',
    colEcpc: 'eCPC',
  },
  fa: {
    tabReports: 'گزارش‌ها',
    reportsTitle: 'عملکرد کمپین‌ها',
    reportsHint:
      'سنجه‌های زنده از خط رویدادها. یک نمایش وقتی دیدنی شمرده می‌شود که تبلیغ دست‌کم ۵۰٪ در یک ثانیه پیوسته در زبانه فعال دیده شود.',
    reportsEmpty: 'هنوز کمپینی نیست — یکی بسازید تا آمارش اینجا ظاهر شود.',
    reportsLoading: 'در حال بارگذاری آمار…',
    downloadCsv: 'دانلود CSV',
    csvNote:
      'خروجی CSV در برابر فرمول‌ها ایمن است: سلول‌هایی که با =، +، - یا @ شروع می‌شوند خنثی می‌شوند و سنجه‌های بدون داده به صورت خط تیره (—) صادر می‌شوند.',
    colCampaign: 'کمپین',
    colBilling: 'صورتحساب',
    colImpressions: 'نمایش‌ها',
    colViewable: 'نمایش‌های دیدنی',
    colClicks: 'کلیک‌ها',
    colCtr: 'CTR',
    colSpent: 'هزینه',
    colEcpc: 'eCPC',
  },
  ar: {
    tabReports: 'التقارير',
    reportsTitle: 'أداء الحملات',
    reportsHint:
      'مقاييس مباشرة من مسار الأحداث. تُحتسب الظاهرة كمرئية عندما تكون الإعلان مرئيًا بنسبة 50% على الأقل لثانية متواصلة في تبويب نشط.',
    reportsEmpty: 'لا توجد حملات بعد — أنشئ واحدة وستظهر إحصاءاتها هنا.',
    reportsLoading: 'جارٍ تحميل الإحصاءات…',
    downloadCsv: 'تنزيل CSV',
    csvNote:
      'تصدير CSV آمن من الصيغ: الخلايا التي تبدأ بـ = أو + أو - أو @ تُحيَّد، والمقاييس بلا بيانات تُصدَّر كشرطة (—).',
    colCampaign: 'الحملة',
    colBilling: 'الفوترة',
    colImpressions: 'الظهور',
    colViewable: 'الظهور المرئي',
    colClicks: 'النقرات',
    colCtr: 'CTR',
    colSpent: 'المنفق',
    colEcpc: 'eCPC',
  },
  zh: {
    tabReports: '报告',
    reportsTitle: '广告系列效果',
    reportsHint:
      '来自事件管道的实时指标。当广告在活动标签页中至少 50% 可见并持续一秒时，该次展示才算有效可见。',
    reportsEmpty: '还没有广告系列——创建一个，统计数据就会显示在这里。',
    reportsLoading: '正在加载统计…',
    downloadCsv: '下载 CSV',
    csvNote:
      'CSV 导出可防公式注入：以 =、+、- 或 @ 开头的单元格会被中和，无数据的指标以破折号（—）导出。',
    colCampaign: '广告系列',
    colBilling: '计费',
    colImpressions: '展示',
    colViewable: '可见展示',
    colClicks: '点击',
    colCtr: '点击率',
    colSpent: '花费',
    colEcpc: 'eCPC',
  },
  ko: {
    tabReports: '리포트',
    reportsTitle: '캠페인 성과',
    reportsHint:
      '이벤트 파이프라인의 실시간 지표입니다. 활성 탭에서 광고가 최소 50% 보이며 1초 연속 유지되면 조회 가능 노출로 계산됩니다.',
    reportsEmpty: '아직 캠페인이 없습니다. 하나 만들면 통계가 여기에 표시됩니다.',
    reportsLoading: '통계를 불러오는 중…',
    downloadCsv: 'CSV 다운로드',
    csvNote:
      'CSV 내보내기는 수식으로부터 안전합니다: =, +, - 또는 @로 시작하는 셀은 무력화되며 데이터 없는 지표는 대시(—)로 내보내집니다.',
    colCampaign: '캠페인',
    colBilling: '과금',
    colImpressions: '노출',
    colViewable: '뷰어블 노출',
    colClicks: '클릭',
    colCtr: 'CTR',
    colSpent: '지출',
    colEcpc: 'eCPC',
  },
  ja: {
    tabReports: 'レポート',
    reportsTitle: 'キャンペーンの成果',
    reportsHint:
      'イベントパイプラインからのライブ指標。アクティブなタブで広告が50%以上見え続けて1秒経過すると、視認可能インプレッションとしてカウントされます。',
    reportsEmpty: 'まだキャンペーンがありません。作成すると統計がここに表示されます。',
    reportsLoading: '統計を読み込み中…',
    downloadCsv: 'CSVをダウンロード',
    csvNote:
      'CSVエクスポートは数式に対して安全です：=、+、-、@ で始まるセルは無効化され、データのない指標はダッシュ（—）として出力されます。',
    colCampaign: 'キャンペーン',
    colBilling: '課金',
    colImpressions: 'インプレッション',
    colViewable: '視認可能インプレッション',
    colClicks: 'クリック',
    colCtr: 'CTR',
    colSpent: '支出',
    colEcpc: 'eCPC',
  },
  id: {
    tabReports: 'Laporan',
    reportsTitle: 'Performa kampanye',
    reportsHint:
      'Metrik langsung dari pipeline peristiwa. Tayangan dihitung viewable setelah iklan terlihat minimal 50% selama satu detik penuh di tab aktif.',
    reportsEmpty: 'Belum ada kampanye — buat satu dan statistiknya akan muncul di sini.',
    reportsLoading: 'Memuat statistik…',
    downloadCsv: 'Unduh CSV',
    csvNote:
      'Ekspor CSV aman dari formula: sel yang diawali =, +, - atau @ dinetralkan, dan metrik tanpa data diekspor sebagai tanda pisah (—).',
    colCampaign: 'Kampanya',
    colBilling: 'Penagihan',
    colImpressions: 'Tayangan',
    colViewable: 'Tayangan viewable',
    colClicks: 'Klik',
    colCtr: 'CTR',
    colSpent: 'Belanja',
    colEcpc: 'eCPC',
  },
  fil: {
    tabReports: 'Mga Ulat',
    reportsTitle: 'Pagganap ng kampanya',
    reportsHint:
      'Live na metrics mula sa event pipeline. Bilang na viewable ang isang impression kapag 50% pataas ang nakikita ng ad nang tuloy-tuloy na isang segundo sa aktibong tab.',
    reportsEmpty: 'Wala pang kampanya — gumawa ng isa at lalabas dito ang estatistika nito.',
    reportsLoading: 'Nilo-load ang estatistika…',
    downloadCsv: 'I-download ang CSV',
    csvNote:
      'Formula-safe ang CSV export: nene-neutralize ang mga cell na nagsisimula sa =, +, - o @, at ang mga metric na walang datos ay ilalabas bilang em dash (—).',
    colCampaign: 'Kampanya',
    colBilling: 'Billing',
    colImpressions: 'Impressions',
    colViewable: 'Viewable impressions',
    colClicks: 'Klik',
    colCtr: 'CTR',
    colSpent: 'Gastos',
    colEcpc: 'eCPC',
  },
  th: {
    tabReports: 'รายงาน',
    reportsTitle: 'ผลการทำงานของแคมเปญ',
    reportsHint:
      'เมทริกแบบสดจากไปป์ไลน์เหตุการณ์ อิมเพรสชันนับเป็น viewable เมื่อโฆษณามองเห็นอย่างน้อย 50% ต่อเนื่องหนึ่งวินาทีในแท็บที่ใช้งานอยู่',
    reportsEmpty: 'ยังไม่มีแคมเปญ — สร้างหนึ่งแล้วสถิติจะปรากฏที่นี่',
    reportsLoading: 'กำลังโหลดสถิติ…',
    downloadCsv: 'ดาวน์โหลด CSV',
    csvNote:
      'การส่งออก CSV ปลอดภัยจากสูตร: เซลล์ที่ขึ้นต้นด้วย = + - หรือ @ จะถูกทำให้เป็นกลาง และเมทริกที่ไม่มีข้อมูลจะถูกส่งออกเป็นขีดยาว (—)',
    colCampaign: 'แคมเปญ',
    colBilling: 'การเรียกเก็บ',
    colImpressions: 'อิมเพรสชัน',
    colViewable: 'อิมเพรสชันที่มองเห็นได้',
    colClicks: 'คลิก',
    colCtr: 'CTR',
    colSpent: 'ใช้ไป',
    colEcpc: 'eCPC',
  },
  vi: {
    tabReports: 'Báo cáo',
    reportsTitle: 'Hiệu quả chiến dịch',
    reportsHint:
      'Số liệu trực tiếp từ đường ống sự kiện. Một lượt hiển thị được tính là viewable khi quảng cáo hiển thị tối thiểu 50% liên tục một giây trong thẻ đang hoạt động.',
    reportsEmpty: 'Chưa có chiến dịch nào — hãy tạo một chiến dịch và thống kê sẽ xuất hiện tại đây.',
    reportsLoading: 'Đang tải thống kê…',
    downloadCsv: 'Tải CSV',
    csvNote:
      'Bản xuất CSV an toàn trước công thức: ô bắt đầu bằng =, +, - hoặc @ được trung hòa, và các chỉ số không có dữ liệu được xuất dưới dạng gạch dài (—).',
    colCampaign: 'Chiến dịch',
    colBilling: 'Thanh toán',
    colImpressions: 'Lượt hiển thị',
    colViewable: 'Lượt hiển thị viewable',
    colClicks: 'Lượt nhấp',
    colCtr: 'CTR',
    colSpent: 'Đã chi',
    colEcpc: 'eCPC',
  },
  tr: {
    tabReports: 'Raporlar',
    reportsTitle: 'Kampanya performansı',
    reportsHint:
      'Olay hattından canlı metrikler. Bir gösterim, reklam aktif sekmede en az %50 görünür durumda bir saniye kesintisiz kaldığında görülebilir sayılır.',
    reportsEmpty: 'Henüz kampanya yok — bir tane oluşturun, istatistikleri burada görünecek.',
    reportsLoading: 'İstatistikler yükleniyor…',
    downloadCsv: 'CSV indir',
    csvNote:
      'CSV dışa aktarımı formül açısından güvenlidir: =, +, - veya @ ile başlayan hücreler etkisizleştirilir ve verisi olmayan metrikler uzun çizgi (—) olarak aktarılır.',
    colCampaign: 'Kampanya',
    colBilling: 'Faturalama',
    colImpressions: 'Gösterim',
    colViewable: 'Görülebilir gösterim',
    colClicks: 'Tıklama',
    colCtr: 'CTR',
    colSpent: 'Harcanan',
    colEcpc: 'eCPC',
  },
  ur: {
    tabReports: 'رپورٹس',
    reportsTitle: 'کمپین کی کارکردگی',
    reportsHint:
      'ایونٹ پائپ لائن سے لائیو میٹرکس۔ امپریشن تب نژیر (viewable) شمار ہوتا ہے جب اشتہار ایک فعال ٹیب میں کم از کم 50% مسلسل ایک سیکنڈ تک نظر آئے۔',
    reportsEmpty: 'ابھی کوئی کمپین نہیں — ایک بنائیں اور اس کے اعداد یہاں نظر آئیں گے۔',
    reportsLoading: 'اعداد لوڈ ہو رہے ہیں…',
    downloadCsv: 'CSV ڈاؤن لوڈ',
    csvNote:
      'CSV ایکسپورٹ فارمولا محفوظ ہے: =، +، - یا @ سے شروع ہونے والے سیل غیر فعال کر دیے جاتے ہیں، اور بغیر ڈیٹا والے میٹرکس ڈیش (—) کے طور پر ایکسپورٹ ہوتے ہیں۔',
    colCampaign: 'کمپین',
    colBilling: 'بلنگ',
    colImpressions: 'امپریشن',
    colViewable: 'نژیر امپریشن',
    colClicks: 'کلکس',
    colCtr: 'CTR',
    colSpent: 'خرچ',
    colEcpc: 'eCPC',
  },
}

// colCampaign is EXCLUDED: it already exists in every dictionary (Phase 2
// campaign list) and is reused by the Reports tab.
const KEYS = Object.keys(PAYLOADS.en!).filter((k) => k !== 'colCampaign')
const LOCALES = Object.keys(PAYLOADS)

let failed = 0
for (const locale of LOCALES) {
  const path = resolve(root, `src/i18n/messages/${locale}.ts`)
  const source = readFileSync(path, 'utf8')
  if (source.includes('tabReports:')) {
    console.log(`  [skip] ${locale}: Phase 3 reports keys already present`)
    continue
  }
  const lines = source.split('\n')
  const anchor = lines.findIndex((l) => /^\s*tabCampaigns: .*,\s*$/.test(l))
  if (anchor === -1) {
    console.error(`  [FAIL] ${locale}: tabCampaigns anchor not found`)
    failed++
    continue
  }
  const indent = (lines[anchor]!.match(/^\s*/) ?? [''])[0]!
  const block = [
    `${indent}// ---- Phase 3: Reports (event pipeline metrics) ----`,
    ...KEYS.map((k) => {
      const value = PAYLOADS[locale]![k]!
      return `${indent}${k}: ${JSON.stringify(value)},`
    }),
  ]
  lines.splice(anchor + 1, 0, ...block)
  writeFileSync(path, lines.join('\n'))
  console.log(`  [ok]   ${locale}: +${KEYS.length} Phase 3 reports keys`)
}

// Post-verify: every locale must carry every key.
for (const locale of LOCALES) {
  const path = resolve(root, `src/i18n/messages/${locale}.ts`)
  const source = readFileSync(path, 'utf8')
  const missing = KEYS.filter((k) => !source.includes(`${k}:`))
  if (missing.length > 0) {
    console.error(`  [FAIL] ${locale}: missing ${missing.join(', ')}`)
    failed++
  }
}

console.log(failed === 0 ? '[inject-ads-phase3] all locales updated' : `[inject-ads-phase3] FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
