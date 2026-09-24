import { open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { windowsFilePrivacy } from "./windows-file-privacy.js";
/** Create only a new file, and establish its private ACL before writing content. */
export async function writeNewPrivateFile(path, content) {
    await windowsFilePrivacy(dirname(path), 'directory');
    const file = await open(path, 'wx', 0o600);
    let complete = false;
    try {
        await windowsFilePrivacy(path, 'file', true);
        await file.writeFile(content, 'utf8');
        await file.sync();
        complete = true;
    }
    finally {
        await file.close();
        if (!complete)
            await unlink(path).catch(() => { });
    }
}
