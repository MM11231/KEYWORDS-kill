(function (exports) {
    "use strict";

    const { before } = vendetta.patcher;
    const { findByName } = vendetta.metro;
    const { React, ReactNative } = vendetta.metro.common;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormInput, FormRow, FormSwitch, FormText } = vendetta.ui.components.Forms;
    const { ScrollView, Alert } = ReactNative;
    const storage = vendetta.plugin.storage;
    const h = React.createElement;

    // ---------- 初始化 / 兼容旧版（逗号分隔） ----------
    if (!Array.isArray(storage.list)) {
        const old = typeof storage.keywords === "string" ? storage.keywords : "";
        storage.list = old
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((w) => ({ word: w, enabled: true }));
    }
    if (typeof storage.enabled !== "boolean") storage.enabled = true;

    function toast(text) {
        try {
            vendetta.ui.toasts.showToast(text);
        } catch (e) {}
    }

    // ---------- 遮罩逻辑 ----------
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cache = { sig: null, re: null };

    function getRegex() {
        const words = storage.list
            .filter((i) => i.enabled && i.word)
            .map((i) => i.word)
            .sort((a, b) => b.length - a.length);
        const sig = words.join("\u0000");
        if (cache.sig !== sig) {
            cache.sig = sig;
            cache.re = words.length ? new RegExp(words.map(esc).join("|"), "gi") : null;
        }
        return cache.re;
    }

    function mask(text) {
        if (!storage.enabled) return text;
        const re = getRegex();
        if (!re) return text;
        re.lastIndex = 0;
        return text.replace(re, (m, offset) => {
            if (text.slice(Math.max(0, offset - 2), offset) === "||") return m;
            if (text.slice(offset + m.length, offset + m.length + 2) === "||") return m;
            return "||" + m + "||";
        });
    }

    let unpatch;

    exports.onLoad = () => {
        const RowManager = findByName("RowManager");
        unpatch = before("generate", RowManager.prototype, ([row]) => {
            try {
                if (!row || row.rowType !== 1 || !row.message) return;
                const msg = row.message;
                const cur = msg.content;
                if (typeof cur !== "string" || !cur) return;

                // 记住原文，这样关闭某个关键词后能恢复显示
                let orig = cur;
                if (msg.__kwmOut !== undefined && cur === msg.__kwmOut) orig = msg.__kwmOrig;

                const next = mask(orig);
                msg.__kwmOrig = orig;
                msg.__kwmOut = next;
                if (next !== cur) msg.content = next;
            } catch (e) {
                // 出错就跳过这条消息
            }
        });
    };

    exports.onUnload = () => {
        if (unpatch) unpatch();
    };

    // ---------- 设置页 ----------
    exports.settings = () => {
        useProxy(storage);
        const [draft, setDraft] = React.useState("");
        const [query, setQuery] = React.useState("");

        const add = () => {
            const w = draft.trim();
            if (!w) return toast("请先输入关键词");
            if (storage.list.some((i) => i.word.toLowerCase() === w.toLowerCase())) {
                return toast("这个关键词已经存在");
            }
            storage.list = [{ word: w, enabled: true }, ...storage.list];
            setDraft("");
            toast("已添加：" + w);
        };

        const q = query.trim().toLowerCase();
        const shown = storage.list.filter((i) => !q || i.word.toLowerCase().includes(q));

        const setShown = (v) => {
            const set = new Set(shown.map((i) => i.word));
            storage.list = storage.list.map((i) => (set.has(i.word) ? { word: i.word, enabled: v } : i));
        };

        const toggle = (word, v) => {
            storage.list = storage.list.map((i) => (i.word === word ? { word: word, enabled: v } : i));
        };

        const remove = (word) => {
            Alert.alert("删除关键词", "确定删除「" + word + "」吗？", [
                { text: "取消", style: "cancel" },
                {
                    text: "删除",
                    style: "destructive",
                    onPress: () => {
                        storage.list = storage.list.filter((i) => i.word !== word);
                    },
                },
            ]);
        };

        return h(
            ScrollView,
            { style: { flex: 1 } },

            h(
                FormSection,
                { title: "总开关" },
                h(FormRow, {
                    label: "启用关键词遮罩",
                    trailing: h(FormSwitch, {
                        value: storage.enabled,
                        onValueChange: (v) => {
                            storage.enabled = v;
                        },
                    }),
                })
            ),

            h(
                FormSection,
                { title: "添加关键词" },
                h(FormInput, {
                    title: "新关键词",
                    placeholder: "输入一个关键词",
                    value: draft,
                    onChange: setDraft,
                }),
                h(FormRow, { label: "确认添加", onPress: add })
            ),

            h(
                FormSection,
                { title: "关键词列表（" + shown.length + "/" + storage.list.length + "）" },
                h(FormInput, {
                    title: "搜索",
                    placeholder: "输入文字筛选关键词",
                    value: query,
                    onChange: setQuery,
                }),
                h(FormRow, { label: "将下列全部启用", onPress: () => setShown(true) }),
                h(FormRow, { label: "将下列全部停用", onPress: () => setShown(false) }),
                shown.length
                    ? shown.map((i) =>
                          h(FormRow, {
                              key: i.word,
                              label: i.word,
                              subLabel: (i.enabled ? "已启用" : "已停用") + " · 点击此行可删除",
                              onPress: () => remove(i.word),
                              trailing: h(FormSwitch, {
                                  value: i.enabled,
                                  onValueChange: (v) => toggle(i.word, v),
                              }),
                          })
                      )
                    : h(FormText, {}, q ? "没有匹配的关键词" : "还没有添加关键词")
            )
        );
    };

    return exports;
})({});
