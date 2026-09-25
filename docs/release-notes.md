# Sing-box Service Check 1.15.0

- Поддержка Tachyon 1.4.0: sing-box, Steer и Steer Extended; проверки доступности и диагностика с учётом активного движка.
- При установленном Tachyon скрыты вкладки «Подбор стратегии Zapret» и «Фиксы Forkop».
- Новый пакет `luci-app-sing-box-service-check`. Настройки предыдущих версий копируются в `/etc/sing-box-service-check`, старый каталог остаётся резервной копией; старый CLI-алиас продолжает работать.

## Обновление

На OpenWrt с opkg установите новый IPK. Метаданные пакета заменяют прежний `luci-app-forkop-servicecheck`. На OpenWrt с apk установите новый APK, собранный через `make-apk.sh`. Самодостаточный установщик также удаляет старый пакет после проверки новой версии.

## Удаление

```sh
opkg remove luci-app-sing-box-service-check
# либо на OpenWrt с apk
apk del luci-app-sing-box-service-check
# если модуль установлен без пакетного менеджера
sh install-sing-box-service-check.sh --uninstall
```

Пользовательские настройки в `/etc/sing-box-service-check` сохраняются. При необходимости удалите их вручную после сохранения резервной копии.
