/**
 * BlockBee top-up keys (3 new entries inside the existing `ads` namespace)
 * for all 20 locales. Used by scripts/ui18n-codegen/inject-blockbee.ts.
 */
export interface BlockbeeAdsKeys {
  topUpCoin: string
  topUpCoinNote: string
  topUpBlockbeeNote: string
}

export const BLOCKBEE_ADS_KEYS: Record<string, BlockbeeAdsKeys> = {
  en: {
    topUpCoin: 'Coin / network',
    topUpCoinNote: 'Pick the network you will pay from — the address works for that coin only.',
    topUpBlockbeeNote:
      'Send the amount in the chosen coin to this address. The payment is confirmed on-chain (usually a few minutes) — this dialog updates automatically.',
  },
  ru: {
    topUpCoin: 'Монета / сеть',
    topUpCoinNote: 'Выберите сеть, из которой будете платить, — адрес работает только для этой монеты.',
    topUpBlockbeeNote:
      'Отправьте сумму в выбранной монете на этот адрес. Платёж подтверждается в блокчейне (обычно несколько минут) — окно обновится автоматически.',
  },
  uk: {
    topUpCoin: 'Монета / мережа',
    topUpCoinNote: 'Оберіть мережу, з якої платитимете, — адреса працює лише для цієї монети.',
    topUpBlockbeeNote:
      'Надішліть суму в обраній монеті на цю адресу. Платіж підтверджується в блокчейні (зазвичай кілька хвилин) — вікно оновиться автоматично.',
  },
  hi: {
    topUpCoin: 'कॉइन / नेटवर्क',
    topUpCoinNote: 'जिस नेटवर्क से भुगतान करेंगे उसे चुनें — यह पता केवल उसी कॉइन के लिए काम करता है।',
    topUpBlockbeeNote:
      'चुनी हुई कॉइन में राशि इस पते पर भेजें। भुगतान ऑन-चेन कन्फर्म होता है (आमतौर पर कुछ मिनट) — यह विंडो अपने आप अपडेट हो जाएगी।',
  },
  zh: {
    topUpCoin: '币种 / 网络',
    topUpCoinNote: '选择用于支付的网络——该地址仅支持所选币种。',
    topUpBlockbeeNote:
      '将相应金额以所选币种发送到此地址。付款在链上确认（通常几分钟）——此窗口会自动更新。',
  },
  fa: {
    topUpCoin: 'کوین / شبکه',
    topUpCoinNote: 'شبکه‌ای را که از آن پرداخت می‌کنید انتخاب کنید — این آدرس فقط برای همان کوین کار می‌کند.',
    topUpBlockbeeNote:
      'مبلغ را با کوین انتخاب‌شده به این آدرس بفرستید. پرداخت روی زنجیره تأیید می‌شود (معمولاً چند دقیقه) — این پنجره خودکار به‌روز می‌شود.',
  },
  ar: {
    topUpCoin: 'العملة / الشبكة',
    topUpCoinNote: 'اختر الشبكة التي ستدفع منها — هذا العنوان يعمل مع هذه العملة فقط.',
    topUpBlockbeeNote:
      'أرسل المبلغ بالعملة المختارة إلى هذا العنوان. يتم تأكيد الدفع على الشبكة (عادة خلال دقائق) — ستتحدث هذه النافذة تلقائيًا.',
  },
  bn: {
    topUpCoin: 'কয়েন / নেটওয়ার্ক',
    topUpCoinNote: 'যে নেটওয়ার্ক থেকে পেমেন্ট করবেন তা বেছে নিন — এই ঠিকানা শুধু ওই কয়েনের জন্য কাজ করে।',
    topUpBlockbeeNote:
      'নির্বাচিত কয়েনে টাকা এই ঠিকানায় পাঠান। পেমেন্ট অন-চেইন নিশ্চিত হয় (সাধারণত কয়েক মিনিট) — এই উইন্ডোটি স্বয়ংক্রিয়ভাবে আপডেট হবে।',
  },
  es: {
    topUpCoin: 'Moneda / red',
    topUpCoinNote: 'Elige la red desde la que pagarás: la dirección solo funciona con esa moneda.',
    topUpBlockbeeNote:
      'Envía el importe en la moneda elegida a esta dirección. El pago se confirma on-chain (normalmente en unos minutos); este diálogo se actualiza automáticamente.',
  },
  pt: {
    topUpCoin: 'Moeda / rede',
    topUpCoinNote: 'Escolha a rede pela qual vai pagar — o endereço funciona apenas para essa moeda.',
    topUpBlockbeeNote:
      'Envie o valor na moeda escolhida para este endereço. O pagamento é confirmado on-chain (normalmente em alguns minutos) — esta janela será atualizada automaticamente.',
  },
  fr: {
    topUpCoin: 'Monnaie / réseau',
    topUpCoinNote: 'Choisissez le réseau depuis lequel vous paierez — cette adresse ne fonctionne que pour cette monnaie.',
    topUpBlockbeeNote:
      'Envoyez le montant dans la monnaie choisie à cette adresse. Le paiement est confirmé on-chain (généralement en quelques minutes) — cette fenêtre se met à jour automatiquement.',
  },
  de: {
    topUpCoin: 'Coin / Netzwerk',
    topUpCoinNote: 'Wähle das Netzwerk, von dem aus du zahlst — die Adresse funktioniert nur für diesen Coin.',
    topUpBlockbeeNote:
      'Sende den Betrag im gewählten Coin an diese Adresse. Die Zahlung wird on-chain bestätigt (meist in wenigen Minuten) — dieses Fenster aktualisiert sich automatisch.',
  },
  ko: {
    topUpCoin: '코인 / 네트워크',
    topUpCoinNote: '결제에 사용할 네트워크를 선택하세요 — 이 주소는 해당 코인에만 사용할 수 있습니다.',
    topUpBlockbeeNote:
      '선택한 코인으로 이 주소에 금액을 보내세요. 결제는 온체인으로 확인됩니다(보통 몇 분) — 이 창은 자동으로 업데이트됩니다.',
  },
  ja: {
    topUpCoin: 'コイン / ネットワーク',
    topUpCoinNote: '支払いに使うネットワークを選択してください — このアドレスはそのコイン専用です。',
    topUpBlockbeeNote:
      '選択したコインでこのアドレスに金額を送金してください。決済はオンチェーンで確認されます（通常数分）— この画面は自動的に更新されます。',
  },
  id: {
    topUpCoin: 'Koin / jaringan',
    topUpCoinNote: 'Pilih jaringan asal pembayaran — alamat ini hanya berlaku untuk koin tersebut.',
    topUpBlockbeeNote:
      'Kirim jumlahnya dalam koin pilihan ke alamat ini. Pembayaran dikonfirmasi on-chain (biasanya beberapa menit) — jendela ini diperbarui otomatis.',
  },
  fil: {
    topUpCoin: 'Barya / network',
    topUpCoinNote: 'Piliin ang network na pagbabayaran mo — gumagana lang ang address para sa baryang iyon.',
    topUpBlockbeeNote:
      'Ipadala ang halaga sa piniling barya sa address na ito. Kumpirmadong on-chain ang bayad (karaniwang ilang minuto) — awtomatikong mag-a-update ang window na ito.',
  },
  th: {
    topUpCoin: 'เหรียญ / เครือข่าย',
    topUpCoinNote: 'เลือกเครือข่ายที่จะใช้จ่าย — ที่อยู่นี้ใช้ได้กับเหรียญนั้นเท่านั้น',
    topUpBlockbeeNote:
      'ส่งจำนวนเงินตามเหรียญที่เลือกไปยังที่อยู่นี้ การชำระเงินจะยืนยันบนเชน (ปกติไม่กี่นาที) — หน้าต่างนี้จะอัปเดตอัตโนมัติ',
  },
  vi: {
    topUpCoin: 'Đồng tiền / mạng',
    topUpCoinNote: 'Chọn mạng bạn sẽ thanh toán — địa chỉ này chỉ dùng cho đồng tiền đó.',
    topUpBlockbeeNote:
      'Gửi số tiền bằng đồng tiền đã chọn đến địa chỉ này. Khoản thanh toán được xác nhận on-chain (thường trong vài phút) — hộp thoại này sẽ tự cập nhật.',
  },
  tr: {
    topUpCoin: 'Coin / ağ',
    topUpCoinNote: 'Ödeme yapacağınız ağı seçin — bu adres yalnızca o coin için geçerlidir.',
    topUpBlockbeeNote:
      'Tutarı seçtiğiniz coin ile bu adrese gönderin. Ödeme on-chain onaylanır (genellikle birkaç dakika) — bu pencere otomatik güncellenir.',
  },
  ur: {
    topUpCoin: 'کرنسی / نیٹ ورک',
    topUpCoinNote: 'جس نیٹ ورک سے ادائیگی کریں گے وہ منتخب کریں — یہ پتہ صرف اسی کرنسی کے لیے کام کرتا ہے۔',
    topUpBlockbeeNote:
      'منتخب کرنسی میں رقم اس پتے پر بھیجیں۔ ادائیگی آن چین تصدیق ہوتی ہے (عام طور پر چند منٹ) — یہ ونڈو خودکار طور پر اپڈیٹ ہو جائے گی۔',
  },
}
