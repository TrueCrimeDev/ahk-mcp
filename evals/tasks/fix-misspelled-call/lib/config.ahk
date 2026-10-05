SaveConfig(map, path) {
  for key, value in map
    IniWrite(value, path, "main", key)
}

LoadConfig(path) {
  return IniRead(path, "main")
}
