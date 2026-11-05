/**
 * SettingsReader — settings.yaml 只读解析
 *
 * 从 ~/.dsh/settings.yaml 中读取模型配置信息。
 * 只读，不修改 settings.yaml。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
export class SettingsReader {
    /** settings.yaml 缓存 */
    settingsCache;
    /**
     * 从 settings.yaml 的 agent-default-model 字段读取默认模型路由
     */
    readDefaultRoute() {
        const settings = this.loadSettings();
        if (!settings)
            return undefined;
        const defaultModel = settings['agent-default-model'];
        if (defaultModel?.provider && defaultModel?.model) {
            return { provider: defaultModel.provider, model: defaultModel.model };
        }
        return undefined;
    }
    loadSettings() {
        if (this.settingsCache !== undefined)
            return this.settingsCache;
        try {
            const settingsPath = resolve(homedir(), '.dsh', 'settings.yaml');
            if (!existsSync(settingsPath)) {
                this.settingsCache = null;
                return null;
            }
            const content = readFileSync(settingsPath, 'utf8');
            this.settingsCache = yaml.load(content);
            return this.settingsCache;
        }
        catch {
            this.settingsCache = null;
            return null;
        }
    }
}
//# sourceMappingURL=settings-reader.js.map