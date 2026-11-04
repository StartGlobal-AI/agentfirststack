/** A GTM web container export (Admin > Export container, exportFormatVersion 2), trimmed to what the importer reads. */
const T = (key: string, value: string) => ({ type: "TEMPLATE", key, value });
const B = (key: string, value: boolean) => ({ type: "BOOLEAN", key, value: String(value) });
const row = (pairs: Record<string, string>) => ({ type: "MAP", map: Object.entries(pairs).map(([k, v]) => T(k, v)) });
const cond = (type: string, arg0: string, arg1: string, extra: object[] = []) => ({
  type,
  parameter: [T("arg0", arg0), T("arg1", arg1), ...extra],
});

export const GTM_EXPORT = {
  exportFormatVersion: 2,
  exportTime: "2026-10-30 10:00:00",
  containerVersion: {
    container: { publicId: "GTM-ABC1234", usageContext: ["WEB"] },
    builtInVariable: [
      { type: "PAGE_URL", name: "Page URL" },
      { type: "CLICK_URL", name: "Click URL" },
    ],
    folder: [{ name: "Ads" }],
    customTemplate: [
      {
        templateId: "41",
        name: "Facebook Pixel",
        galleryReference: { owner: "facebookarchive", repository: "GoogleTagManager-WebTemplate-For-FacebookPixel" },
      },
      { templateId: "42", name: "Hotjar Tracking Code", galleryReference: { owner: "hotjar", repository: "hotjar-gtm-template" } },
    ],
    variable: [
      {
        name: "DLV - value",
        type: "v",
        parameter: [T("name", "ecommerce.value"), B("setDefaultValue", false), { type: "INTEGER", key: "dataLayerVersion", value: "2" }],
      },
      { name: "DLV - order id", type: "v", parameter: [T("name", "ecommerce.transaction_id")] },
      { name: "GA4 ID", type: "c", parameter: [T("value", "G-ABC123XYZ")] },
      { name: "URL - plan", type: "u", parameter: [T("component", "QUERY"), T("queryKey", "plan")] },
      { name: "Cookie - uid", type: "k", parameter: [T("name", "uid")], formatValue: { caseConversionType: "LOWERCASE" } },
      {
        name: "Plan value",
        type: "smm",
        parameter: [
          T("input", "{{URL - plan}}"),
          { type: "LIST", key: "map", list: [row({ key: "pro", value: "99" }), row({ key: "basic", value: "19" })] },
          B("setDefaultValue", true),
          T("defaultValue", "0"),
        ],
      },
      {
        name: "Page group",
        type: "remm",
        parameter: [
          T("input", "{{Page Path}}"),
          { type: "LIST", key: "map", list: [row({ key: "/blog/(.*)", value: "blog:$1" })] },
          B("fullMatch", true),
          B("ignoreCase", true),
        ],
      },
      { name: "JS - cart size", type: "jsm", parameter: [T("javascript", "function() { return window.cart ? window.cart.length : 0; }")] },
      { name: "JS - templated", type: "jsm", parameter: [T("javascript", "function() { return {{DLV - value}} * 2; }")] },
      { name: "Product id", type: "aev", parameter: [T("varType", "ATTRIBUTE"), T("attribute", "data-product-id")] },
      { name: "Clicked element", type: "aev", parameter: [T("varType", "ELEMENT")] },
      { name: "Random", type: "r", parameter: [] },
      { name: "GA Settings", type: "gas", parameter: [T("trackingId", "UA-1-1")] },
    ],
    trigger: [
      { triggerId: "10", name: "Purchase", type: "CUSTOM_EVENT", customEventFilter: [cond("EQUALS", "{{_event}}", "purchase")] },
      {
        triggerId: "11",
        name: "Outbound links",
        type: "LINK_CLICK",
        filter: [cond("CONTAINS", "{{Click URL}}", "partner.example.net")],
        waitForTags: B("waitForTags", true),
        waitForTagsTimeout: T("waitForTagsTimeout", "2000"),
        checkValidation: B("checkValidation", true),
        autoEventFilter: [cond("MATCH_REGEX", "{{Page URL}}", ".*")],
      },
      { triggerId: "12", name: "Contact form", type: "FORM_SUBMISSION", checkValidation: B("checkValidation", true) },
      {
        triggerId: "13",
        name: "Thank you pages",
        type: "PAGEVIEW",
        filter: [cond("MATCH_REGEX", "{{Page Path}}", "^/thank-?you", [B("ignore_case", true)])],
      },
      {
        triggerId: "14",
        name: "Scroll 50/90",
        type: "SCROLL_DEPTH",
        parameter: [
          B("verticalThresholdOn", true),
          T("verticalThresholdUnits", "PERCENT"),
          T("verticalThresholdsPercent", "50,90"),
          B("horizontalThresholdOn", false),
        ],
      },
      {
        triggerId: "15",
        name: "Pricing seen",
        type: "ELEMENT_VISIBILITY",
        parameter: [
          T("selectorType", "ID"),
          T("elementId", "pricing"),
          T("firingFrequency", "ONCE"),
          T("onScreenRatio", "50"),
          B("useOnScreenDuration", true),
          T("onScreenDuration", "2000"),
        ],
      },
      {
        triggerId: "16",
        name: "YouTube",
        type: "YOU_TUBE_VIDEO",
        parameter: [
          B("captureStart", true),
          B("captureComplete", true),
          B("captureProgress", true),
          T("progressThresholdsPercent", "25,50,75"),
        ],
      },
      {
        triggerId: "17",
        name: "Engaged",
        type: "TRIGGER_GROUP",
        parameter: [
          {
            type: "LIST",
            key: "triggerIds",
            list: [
              { type: "TRIGGER_REFERENCE", value: "14" },
              { type: "TRIGGER_REFERENCE", value: "15" },
            ],
          },
        ],
      },
      { triggerId: "18", name: "AMP click", type: "AMP_CLICK" },
      { triggerId: "19", name: "Random filter", type: "PAGEVIEW", filter: [cond("EQUALS", "{{Random}}", "1")] },
      {
        triggerId: "20",
        name: "Big order",
        type: "CUSTOM_EVENT",
        customEventFilter: [cond("EQUALS", "{{_event}}", "purchase")],
        filter: [cond("GREATER", "{{DLV - value}}", "100")],
      },
    ],
    tag: [
      {
        tagId: "1",
        name: "Google tag",
        type: "googtag",
        parameter: [
          T("tagId", "{{GA4 ID}}"),
          {
            type: "LIST",
            key: "configSettingsTable",
            list: [
              row({ parameter: "send_page_view", parameterValue: "true" }),
              row({ parameter: "cookie_prefix", parameterValue: "shop" }),
            ],
          },
        ],
        firingTriggerId: ["2147479553"],
      },
      {
        tagId: "2",
        name: "GA4 - purchase",
        type: "gaawe",
        parameter: [
          T("eventName", "purchase"),
          T("measurementIdOverride", "{{GA4 ID}}"),
          {
            type: "LIST",
            key: "eventSettingsTable",
            list: [
              row({ parameter: "value", parameterValue: "{{DLV - value}}" }),
              row({ parameter: "transaction_id", parameterValue: "{{DLV - order id}}" }),
            ],
          },
        ],
        firingTriggerId: ["10"],
        priority: { type: "INTEGER", value: "5" },
      },
      {
        tagId: "3",
        name: "Ads conversion",
        type: "awct",
        parameter: [
          T("conversionId", "123456789"),
          T("conversionLabel", "AbCdEfGh"),
          T("conversionValue", "{{DLV - value}}"),
          T("currencyCode", "USD"),
        ],
        firingTriggerId: ["10"],
        blockingTriggerId: ["18"],
      },
      { tagId: "4", name: "Conversion Linker", type: "gclidw", firingTriggerId: ["2147479553"] },
      {
        tagId: "5",
        name: "Chat widget",
        type: "html",
        parameter: [
          T("html", "<script src='https://chat.example.net/w.js' data-plan='{{URL - plan}}'></script>"),
          B("supportDocumentWrite", false),
        ],
        firingTriggerId: ["2147479553"],
        consentSettings: {
          consentStatus: "NEEDED",
          consentType: { type: "LIST", list: [{ type: "TEMPLATE", value: "functionality_storage" }] },
        },
      },
      {
        tagId: "6",
        name: "Affiliate pixel",
        type: "img",
        parameter: [T("url", "https://aff.example.net/px?o={{DLV - order id}}"), B("useCacheBuster", true)],
        firingTriggerId: ["13"],
        tagFiringOption: "ONCE_PER_LOAD",
      },
      { tagId: "7", name: "UA pageview", type: "ua", parameter: [T("trackingId", "UA-1-1")], firingTriggerId: ["2147479553"] },
      {
        tagId: "8",
        name: "Meta Pixel",
        type: "cvt_9999_41",
        parameter: [T("pixelId", "1234567890123456"), T("standardEventName", "PageView")],
        firingTriggerId: ["2147479553"],
        paused: true,
      },
      { tagId: "9", name: "Hotjar", type: "cvt_9999_42", parameter: [T("hotjar_site_id", "123")], firingTriggerId: ["2147479553"] },
      { tagId: "10", name: "AMP only", type: "html", parameter: [T("html", "<b>x</b>")], firingTriggerId: ["18"] },
      {
        tagId: "11",
        name: "Engaged event",
        type: "gaawe",
        parameter: [T("eventName", "engaged"), T("measurementIdOverride", "G-ABC123XYZ")],
        firingTriggerId: ["17"],
        setupTag: [{ tagName: "Google tag", stopOnSetupFailure: true }],
      },
      {
        tagId: "12",
        name: "Video event",
        type: "gaawe",
        parameter: [T("eventName", "video_progress"), T("measurementIdOverride", "G-ABC123XYZ")],
        firingTriggerId: ["16"],
        scheduleEndMs: "4102444800000",
      },
    ],
  },
};
