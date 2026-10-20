(function (exports) {
    "use strict";

    const { before } = vendetta.patcher;
    const { findByName } = vendetta.metro;
    const { React } = vendetta.metro.common;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormInput } = vendetta.ui.components.Forms;
    const storage = vendetta.plugin.storage;

    if (typeof storage.keywords !== "string") storage.keywords = "";

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 把关键词包成 ||词||，Discord 会自己渲染成点击显示的遮罩
    function mask(text) {
        const words = storage.keywords
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (!words.length) return text;
        const re = new RegExp(words.map(esc).join("|"), "gi");
        return text.replace(re, (m, offset) => {
            // 已经在 || 里面就不重复包
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
                const content = row.message.content;
                if (typeof content !== "string" || !content) return;
                const next = mask(content);
                if (next !== content) row.message.content = next;
            } catch (e) {
                // 出错就跳过这条消息，避免影响聊天
            }
        });
    };

    exports.onUnload = () => {
        if (unpatch) unpatch();
    };

    exports.settings = () => {
        useProxy(storage);
        return React.createElement(
            FormSection,
            { title: "关键词遮罩" },
            React.createElement(FormInput, {
                title: "关键词（逗号分隔）",
                placeholder: "例如：关键词1,关键词2",
                value: storage.keywords,
                onChange: (v) => {
                    storage.keywords = v;
                },
            })
        );
    };

    return exports;
})({});
