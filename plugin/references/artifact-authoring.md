# Artifact Authoring — Ortak Referans

Bu doküman, ArtiLens skill'lerinin dispatch ettiği subagent'ların (ve doğrudan
authoring yapan ana oturumun) native Claude artifact'ları yazıp Artifact tool
ile publish etmeden önce okuması gereken ortak sözleşmedir. CLI-render edilmiş
HTML boru hattının yerini alan native-authoring akışının paylaşılan kuralları
buradadır.

## 1. Tek dosya / self-contained kuralı

Artifact tek bir self-contained HTML/Markdown dosyasıdır. Dış script,
stylesheet, font, fetch/XHR/WebSocket, iframe veya uzak dinamik import yok.
Artifact tool'un CSP'si bunu zaten teknik olarak zorunlu kılar — bu madde
hatırlatma amaçlıdır, ekstra bir kısıtlama eklemez. Inline SVG'yi tercih et;
raster veri URI'lerini yalnızca gerektiğinde ve küçük tutarak kullan.

## 2. Stil serbestliği

Styling tamamen sana ait — `artifact-design` skill'ini yükle ve onun
estetiğini uygula. ArtiLens sana renk/font dikte etmez. Aşağıdaki
copy-as-prompt bölümünü sayfaya gömerken de görsel stilini sayfanın geri
kalanına (ışık/koyu tema, tipografi, renk paleti) uydur; markup/JS
sözleşmesi sabit, görünüm sana ait.

## 3. Veri sadakati

Sayıları JSON'dan aynen al, yuvarlama dışında değer üretme/uydurma. Girdi
JSON'da olmayan istatistik, yüzde veya karşılaştırma icat etme; eksik alan
varsa boş/placeholder göster, tahmini sayı yazma.

## 4. Boyut hedefi

Hedef ≤ 2 MiB. Native artifact'lar CLI-render edilmiş HTML'e kıyasla zaten
küçüktür (gömülü büyük veri tabloları, base64 görseller vb. yoksa); bu sınır
bir hatırlatmadır, tetiklenmesi beklenmez.

## 5. Copy-as-prompt protokol v1 sözleşmesi

Kaynak: Faz 17.5'te kaldırılan eski kit renderer'ından (`renderCopyAsPrompt()` ve
`kitScripts()` içindeki `[data-copy-as-prompt]` click handler bloğu) taşındı.
Aşağıdaki markup ve JS bu iki fonksiyonun davranışının birebir karşılığıdır.

### Markup sözleşmesi

```html
<section class="al-panel al-copy" data-artilens="copy-as-prompt">
  <h2>Copy as prompt</h2>
  <textarea data-artilens-note placeholder="Optional note"></textarea>
  <button data-copy-as-prompt>Copy state</button>
  <output data-copy-status></output>
  <script type="application/json" data-artilens-meta>{"artifact":"<slug>","url":null}</script>
</section>
```

- `<script type="application/json" data-artilens-meta>` içeriği JSON'dur ve
  **HTML-escape edilmez** — entity'ler orada literal metin olur ve
  `JSON.parse`'ı bozar. Sadece `<` karakteri, altı karakterlik `\u003c` Unicode kaçış dizisi metniyle değiştirilir
  (bir değer script tag'i asla erken kapatamasın diye; `JSON.parse` bunu
  geri `<` karakterine çevirir). `artifact` alanına artifact'ın slug'ını,
  `url` alanına biliniyorsa yayınlanmış URL'yi (bilinmiyorsa `null`) koy.

### Durum bölgeleri (state regions)

- Gösterilecek/kopyalanacak her ana bölüm `data-artilens-state="<ad>"`
  alır (örn. `data-artilens-state="diff"`, `data-artilens-state="kanban"`).
- Düzenlenebilir/seçilebilir öğeler `data-change-op="<op>"` +
  `data-target="<hedef>"` alır (checkbox, radio, sürüklenebilir kart vb.).
- Kanban benzeri kartlar `data-card="<id>"` + üst kolon
  `data-column="<id>"` alır; kart aynı zamanda `data-change-op="move"`
  taşıyabilir.

### Protokol JS'i

`kitScripts()`'teki `[data-copy-as-prompt]` click handler bloğu — davranışsal
olarak birebir, sayfaya aynen göm:

```js
document.querySelectorAll('[data-copy-as-prompt]').forEach(button => button.addEventListener('click', async () => {
  const meta = JSON.parse(document.querySelector('[data-artilens-meta]')?.textContent || '{}');
  const state = {};
  document.querySelectorAll('[data-artilens-state]').forEach((node, index) => {
    state[node.getAttribute('data-artilens-state') || index] = {
      text: node.innerText.slice(0, 500),
      checked: [...node.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(i => i.checked).map(i => i.getAttribute('data-target') || i.value),
      cards: [...node.querySelectorAll('[data-card]')].map(card => ({ id: card.getAttribute('data-card'), column: card.closest('[data-column]')?.getAttribute('data-column') }))
    };
  });
  const changes = [...document.querySelectorAll('[data-change-op]')].map(node => ({ op: node.getAttribute('data-change-op'), target: node.getAttribute('data-target') || node.getAttribute('data-card'), value: node.checked ?? node.closest('[data-column]')?.getAttribute('data-column') })).filter(item => item.target);
  const payload = { artilens: 1, artifact: meta.artifact, url: meta.url, captured_at: new Date().toISOString(), state, changes, note: document.querySelector('[data-artilens-note]')?.value || '' };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  document.querySelector('[data-copy-status]').textContent = 'Copied protocol v1 JSON';
}));
```

Payload şeması: `{ artilens: 1, artifact, url, captured_at, state, changes, note }`.

### Kapanış talimatı

Bu bölümü ve script'i sayfaya aynen göm; görsel stilini sayfanın geri
kalanına uydur.
