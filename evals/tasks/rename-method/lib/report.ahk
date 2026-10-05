LoadReport(store) {
  store.Load()
  return "Items: " store.Count
}
