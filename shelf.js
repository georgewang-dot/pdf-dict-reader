/* 书架：记住打开过哪些外刊，以及每本读到第几页。

服务器模式把 PDF 副本存进项目的 library/ 目录，下次打开直接取，不用再选文件。
单文件版在 file:// 下没有服务端，IndexedDB 又不可用，只能把进度记在 localStorage，
文件本体存不下，重开时要再选一次同一份文件，选完自动跳回上次那一页。
*/

const SHELF_KEY = "shelf.v1";
const SHELF_SERVER = location.protocol.startsWith("http");

function shelfHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "L" + h.toString(36);
}

function shelfB64(s) {
  const bytes = new TextEncoder().encode(String(s || ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function shelfNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}

function shelfReadLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(SHELF_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (err) {
    return [];
  }
}

function shelfWriteLocal(list) {
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(list));
  } catch (err) {
    /* 存不下就算了，不影响阅读 */
  }
}

function shelfSort(list) {
  return list.slice().sort((a, b) => String(b.lastRead || "").localeCompare(String(a.lastRead || "")));
}

// 有没有服务端撑着，决定了文件能不能留在书架上
function shelfServer() {
  return SHELF_SERVER;
}

function shelfUrl(id) {
  return "api/books/" + encodeURIComponent(id) + "/file";
}

async function shelfList() {
  if (SHELF_SERVER) {
    try {
      const r = await fetch("api/books");
      const j = await r.json();
      return shelfSort(j.books || []);
    } catch (err) {
      return [];
    }
  }
  return shelfSort(shelfReadLocal());
}

async function shelfAdd(file, meta) {
  const pageCount = (meta && meta.pageCount) || 0;

  if (SHELF_SERVER) {
    try {
      const r = await fetch("api/books", {
        method: "POST",
        headers: { "X-Book-Name": shelfB64(file.name || "未命名.pdf") },
        body: file,
      });
      const j = await r.json();
      if (j.ok && j.book) {
        const book = j.book;
        if (pageCount && !book.pageCount) {
          await shelfUpdate(book.id, { pageCount });
          book.pageCount = pageCount;
        }
        return book;
      }
    } catch (err) {
      /* 传不上去就退回只记进度 */
    }
  }

  const id = shelfHash(file.name + "|" + file.size);
  const list = shelfReadLocal();
  let book = list.find((b) => b.id === id);
  if (!book) {
    book = {
      id,
      name: file.name,
      size: file.size,
      pageCount,
      page: 1,
      scale: 0,
      fitMode: true,
      addedAt: shelfNow(),
      lastRead: "",
      localOnly: true,
    };
    list.push(book);
  }
  book.lastRead = shelfNow();
  if (pageCount) book.pageCount = pageCount;
  shelfWriteLocal(list);
  return book;
}

async function shelfUpdate(id, patch) {
  if (!id) return;
  if (SHELF_SERVER) {
    try {
      await fetch("api/books/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return;
    } catch (err) {
      /* 落到本地兜底 */
    }
  }
  const list = shelfReadLocal();
  const book = list.find((b) => b.id === id);
  if (!book) return;
  Object.assign(book, patch);
  book.lastRead = shelfNow();
  shelfWriteLocal(list);
}

// 关页面前那一次要走 keepalive，否则 fetch 会被页面卸载掐掉
function shelfUpdateNow(id, patch) {
  if (!id) return;
  if (SHELF_SERVER) {
    try {
      fetch("api/books/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        keepalive: true,
      });
      return;
    } catch (err) {
      /* 忽略 */
    }
  }
  const list = shelfReadLocal();
  const book = list.find((b) => b.id === id);
  if (!book) return;
  Object.assign(book, patch);
  book.lastRead = shelfNow();
  shelfWriteLocal(list);
}

async function shelfRemove(id) {
  if (!id) return;
  if (SHELF_SERVER) {
    try {
      await fetch("api/books/" + encodeURIComponent(id), { method: "DELETE" });
      return;
    } catch (err) {
      /* 忽略 */
    }
  }
  shelfWriteLocal(shelfReadLocal().filter((b) => b.id !== id));
}

export {
  shelfServer,
  shelfUrl,
  shelfList,
  shelfAdd,
  shelfUpdate,
  shelfUpdateNow,
  shelfRemove,
  shelfNow,
};
