export default function ExtensionsMapper(context) {
  const {extensions: envExtensions} = context.environment;
  const extensions = getExtensions();

  return {
    get,
  };

  function get(activity) {
    const activityExtensions = extensions.reduce(applyExtension, []);
    return {
      activate,
      deactivate,
    };

    function applyExtension(result, Extension) {
      const extension = Extension(activity, context);
      if (extension) result.push(extension);
      return result;
    }

    function activate() {
      activityExtensions.forEach((extension) => extension.activate());
    }
    function deactivate() {
      activityExtensions.forEach((extension) => extension.deactivate());
    }
  }

  function getExtensions() {
    const result = [];
    if (!envExtensions) return result;

    for (const key in envExtensions) {
      const extension = envExtensions[key];
      if (extension) {
        result.push(extension);
      }
    }
    return result;
  }
}