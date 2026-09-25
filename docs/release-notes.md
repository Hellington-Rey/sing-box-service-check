# Sing-box Service Check 1.14.0

## Установка

Для OpenWrt с opkg скачайте IPK из Assets этого релиза в `/tmp` и установите его:

```sh
opkg install /tmp/luci-app-sing-box-service-check_1.14.0-r1_all.ipk
```

Для OpenWrt с apk скачайте `make-apk.sh` из Assets, соберите пакет на устройстве с apk-tools v3 и установите его:

```sh
sh make-apk.sh
apk add --allow-untrusted ./luci-app-sing-box-service-check-1.14.0-r1.apk
```

Если используете самодостаточный установщик из Assets:

```sh
sh install-sing-box-service-check.sh
```

## Удаление

```sh
opkg remove luci-app-sing-box-service-check
# либо на OpenWrt с apk
apk del luci-app-sing-box-service-check
# если модуль установлен без пакетного менеджера
sh install-sing-box-service-check.sh --uninstall
```

Пользовательские настройки в `/etc/sing-box-service-check` сохраняются. При необходимости удалите их вручную после сохранения резервной копии.

## С чем работает

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>⚡ Tachyon</h3>
      <p><strong>sing-box</strong> — проверено с Tachyon 1.4.0.<br>
      <strong>Steer и Steer Extended</strong> — 🧪 тестовый режим.</p>
    </td>
    <td width="50%" valign="top">
      <h3>🏠 HomeProxy</h3>
      <p>Проверка через sing-box, DNS, FakeIP и Clash API. Поддерживается и Re:HomeProxy.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔧 Forkop</h3>
      <p>Проверка маршрута и отдельные исправления Forkop. Вкладка с исправлениями доступна, когда Tachyon не установлен.</p>
    </td>
    <td width="50%" valign="top">
      <h3>🌐 Podkop</h3>
      <p>Диагностика sing-box, DNS и маршрута через штатные параметры Podkop.</p>
    </td>
  </tr>
</table>

## Что нового

- Поддержка Tachyon 1.4.0: sing-box, Steer и Steer Extended (тестовый режим); проверки доступности и диагностика с учётом активного движка.
- При установленном Tachyon скрыты вкладки «Подбор стратегии Zapret» и «Фиксы Forkop».
- LuCI открывается быстрее: начальные сведения загружаются без глубокого опроса Tachyon, а расширенная диагностика выполняется при раскрытии блока. Запросы Zapret при установленном Tachyon не запускаются.
- Исправлена установка LuCI-файла: IPK и APK явно создают каталог нового представления и проверяют наличие JavaScript после установки.
- Переход с тестовой 1.15.0 восстанавливает отсутствующий LuCI-файл перед очисткой opkg.
- Новый пакет `luci-app-sing-box-service-check`. Настройки предыдущих версий копируются в `/etc/sing-box-service-check`, старый каталог остаётся резервной копией; старый CLI-алиас продолжает работать.

## Обновление

На OpenWrt с opkg установите новый IPK. Метаданные пакета заменяют прежний `luci-app-forkop-servicecheck`. На OpenWrt с apk установите новый APK, собранный через `make-apk.sh`. Самодостаточный установщик также удаляет старый пакет после проверки новой версии.

Если на роутере уже была установлена тестовая 1.14.2 или 1.15.x, для перехода на релизную 1.14.0 один раз выполните `opkg install --force-downgrade /tmp/luci-app-sing-box-service-check_1.14.0-r1_all.ipk` после копирования IPK в `/tmp`.
