# 連絡先＋写真 (Contacts PWA)

Google連絡先をiPhone・Windowsのブラウザから閲覧／編集できるPWA。
各連絡先に **顔写真** と **名刺写真** の2枚を登録できます。

- **顔写真** → Google連絡先の写真として保存され、**iPhoneにも同期**されます。さらにGoogle Driveにもコピー保存。
- **名刺写真** → Google Driveの `ContactsPWA_Photos` フォルダに保存（連絡先IDで紐付け）。
- 連絡先データ自体はGoogle Contacts（People API）に直接読み書きするので、iPhoneと自動同期されます。

---

## セットアップ（初回のみ・約10分）

### 1. Google Cloud プロジェクトを作成
1. https://console.cloud.google.com/ を開く
2. 上部のプロジェクト選択 → 「新しいプロジェクト」→ 適当な名前（例: Contacts PWA）で作成

### 2. APIを有効化
「APIとサービス」→「ライブラリ」で以下2つを検索して **有効化**:
- **People API**
- **Google Drive API**

### 3. OAuth同意画面を設定
1. 「APIとサービス」→「OAuth同意画面」
2. User Type = **外部** → 作成
3. アプリ名・サポートメール・デベロッパー連絡先を入力して保存
4. 「対象ユーザー（Test users）」に **自分のGoogleアカウント** を追加
   （公開申請しなくても、テストユーザーなら本人は使えます）

### 4. OAuthクライアントIDを作成
1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
2. アプリの種類 = **ウェブアプリケーション**
3. **承認済みのJavaScript生成元** に、アプリを開くURLを追加:
   - ローカルで使う場合: `http://localhost:8080`
   - GitHub Pagesで使う場合: `https://<ユーザー名>.github.io`
4. 作成後に表示される **クライアントID**（`xxxx.apps.googleusercontent.com`）をコピー

### 5. クライアントIDを設定
`config.js` を開き、`PASTE_YOUR_CLIENT_ID_HERE...` の部分を貼り付けたIDに置き換える。

---

## 起動方法

### A) ローカルで動かす（Windows）
このフォルダで簡易サーバを起動（Node.js使用）:

```powershell
cd C:\Users\souso\ContactsPWA
npx --yes serve -l 8080
```

ブラウザで `http://localhost:8080` を開く。
※ `localhost` 以外（`file://` 直開き）ではGoogleログインが動きません。

### B) iPhoneでも使う / どこからでも使う → GitHub Pagesに公開
1. このフォルダをGitHubリポジトリにpush
2. リポジトリの Settings → Pages → Branch を `main` / root に設定
3. 発行されたURL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）を
   手順4-3の「JavaScript生成元」に追加（**httpsのオリジン**）
4. iPhone SafariでそのURLを開き、共有 → **ホーム画面に追加** でアプリ化

---

## 使い方
- 「ログイン」→ Googleアカウントを選び権限を許可
- 連絡先一覧が表示される
- 行をタップで編集、右下の「＋」で新規作成
- 写真欄をタップして顔写真・名刺写真を選択 → 「保存」
- iPhoneのGoogle連絡先（設定→連絡先→アカウント）にも反映されます

## 注意
- 写真の保存先 `ContactsPWA_Photos` フォルダはこのアプリが作成・管理します（`drive.file` 権限のみ使用＝他のDriveファイルにはアクセスしません）。
- People APIの仕様上、連絡先に直接持てる写真は1枚（顔写真）です。名刺はDrive側で管理しています。
